import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SKILLS_DIR } from './config';
import { formatBytes } from '$lib/format';
import { proxy } from './respond';
import { UpstreamError } from './upstream';
import {
	DESCRIPTION_FILE,
	MAX_SKILL_BYTES,
	SKILL_FILE,
	SKILL_NAME_RE,
	categoryTemplate,
	isValidSkillName,
	skillSegments,
	skillTemplate,
	utf8Length,
	type EditableFile,
	type SkillFileEntry,
	type SkillRef
} from '$lib/skills';

/**
 * Read/write access to the skill tree Hermes loads from disk.
 *
 * This is the one place in the app that writes outside `data/`, into a
 * directory whose contents are fed to an agent that holds a terminal. Two
 * rules, both enforced here and not only in the UI:
 *
 * 1. Every path component comes from `skillSegments()` — a strict allowlist,
 *    so `..`, separators and dotfiles cannot appear.
 * 2. The directory that will hold the file is `realpath`-ed and must still sit
 *    inside the realpath of the skills root. That is what stops a symlink
 *    planted inside the tree from redirecting a write to `~/.hermes/.env`.
 *
 * When `SKILLS_DIR` is unset or unusable — the normal case in `npm run dev`
 * outside Docker — every call raises `skills_dir_unavailable` and the UI hides
 * the feature instead of breaking.
 */

/**
 * A filesystem failure, dressed as an upstream one.
 *
 * The skills directory is not a server, but a route answers a bad path here
 * exactly as it answers a bad request to the gateway — same status, same code,
 * same JSON — so it shares the base class and, since a refactor, the same
 * `(status, message, code)` argument order as its two siblings.
 */
export class SkillsFsError extends UpstreamError {
	constructor(status: number, message: string, code: string) {
		super(status, message, code);
		this.name = 'SkillsFsError';
	}
}

const UNAVAILABLE =
	"L'édition des skills est désactivée : le répertoire des skills n'est pas monté " +
	'(SKILLS_DIR).';

/** Realpath of the skills root, or a typed failure. Cheap enough to redo per call. */
async function skillsRoot(): Promise<string> {
	if (!SKILLS_DIR) throw new SkillsFsError(503, UNAVAILABLE, 'skills_dir_unavailable');
	let resolved: string;
	try {
		resolved = await realpath(SKILLS_DIR);
	} catch {
		throw new SkillsFsError(503, UNAVAILABLE, 'skills_dir_unavailable');
	}
	const info = await stat(resolved).catch(() => null);
	if (!info?.isDirectory()) {
		throw new SkillsFsError(503, UNAVAILABLE, 'skills_dir_unavailable');
	}
	return resolved;
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Realpath a directory under the root and refuse anything that escapes it.
 * `mustExist: false` walks up to the nearest existing ancestor instead, which
 * is what creation needs (the skill directory does not exist yet).
 */
async function resolveDir(root: string, segments: string[]): Promise<string> {
	let real: string;
	try {
		real = await realpath(join(root, ...segments));
	} catch {
		throw new SkillsFsError(404, "Ce skill n'existe pas (ou plus).", 'skill_not_found');
	}
	if (!isInside(root, real)) {
		throw new SkillsFsError(400, 'Chemin de skill refusé.', 'invalid_skill_path');
	}
	return real;
}

function segmentsOrThrow(ref: SkillRef): string[] {
	const segments = skillSegments(ref);
	if (!segments) {
		throw new SkillsFsError(
			400,
			'Nom de catégorie, de skill ou de fichier invalide.',
			'invalid_skill_path'
		);
	}
	return segments;
}

/** Absolute path of an addressable file, with its directory realpath-checked. */
async function resolveFile(root: string, ref: SkillRef): Promise<string> {
	const segments = segmentsOrThrow(ref);
	const dir = await resolveDir(root, segments.slice(0, -1));
	return join(dir, segments[segments.length - 1]);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** A directory entry we are willing to descend into. */
function usableDir(name: string, isDirectory: boolean): boolean {
	// Symlinks are skipped entirely rather than followed: Hermes' own docs
	// mention `~/.hermes/skills/<name>` symlinked to a checked-out repo, and an
	// editor that follows them would be writing somewhere the user never sees.
	return isDirectory && !name.startsWith('.') && SKILL_NAME_RE.test(name);
}

async function entryFor(path: string, ref: SkillRef): Promise<SkillFileEntry | null> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) return null;
	return {
		category: ref.category,
		skill: ref.skill ?? null,
		file: ref.file,
		size: info.size,
		modified: Math.floor(info.mtimeMs / 1000)
	};
}

export async function listSkillFiles(): Promise<SkillFileEntry[]> {
	const root = await skillsRoot();
	const entries: SkillFileEntry[] = [];

	const categories = await readdir(root, { withFileTypes: true });
	for (const category of categories) {
		if (!usableDir(category.name, category.isDirectory())) continue;
		const categoryPath = join(root, category.name);

		const description = await entryFor(join(categoryPath, DESCRIPTION_FILE), {
			category: category.name,
			skill: null,
			file: DESCRIPTION_FILE
		});
		if (description) entries.push(description);

		const skills = await readdir(categoryPath, { withFileTypes: true }).catch(() => []);
		for (const skill of skills) {
			if (!usableDir(skill.name, skill.isDirectory())) continue;
			const entry = await entryFor(join(categoryPath, skill.name, SKILL_FILE), {
				category: category.name,
				skill: skill.name,
				file: SKILL_FILE
			});
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

/** Category names on disk, so the create form can offer them. */
export async function listCategories(): Promise<string[]> {
	const root = await skillsRoot();
	const dirents = await readdir(root, { withFileTypes: true });
	return dirents
		.filter((d) => usableDir(d.name, d.isDirectory()))
		.map((d) => d.name)
		.sort((a, b) => a.localeCompare(b, 'fr'));
}

/** Is the feature usable at all? Never throws — this drives the UI's on/off. */
export async function skillsEditingAvailable(): Promise<boolean> {
	try {
		await skillsRoot();
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export interface SkillFileContent extends SkillFileEntry {
	content: string;
}

export async function readSkillFile(ref: SkillRef): Promise<SkillFileContent> {
	const root = await skillsRoot();
	const path = await resolveFile(root, ref);

	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) {
		throw new SkillsFsError(404, "Ce fichier n'existe pas (ou plus).", 'skill_not_found');
	}
	if (info.size > MAX_SKILL_BYTES) {
		throw new SkillsFsError(
			413,
			`Fichier trop volumineux pour l'éditeur (${formatBytes(info.size)}). ` +
				`Modifiez-le en ligne de commande.`,
			'skill_too_large'
		);
	}

	return {
		category: ref.category,
		skill: ref.skill ?? null,
		file: ref.file,
		size: info.size,
		modified: Math.floor(info.mtimeMs / 1000),
		content: await readFile(path, 'utf8')
	};
}

/**
 * Replace a file's contents atomically.
 *
 * Temp file in the same directory, then `rename`: a reader — the gateway
 * indexing skills, say — sees either the old file or the new one, never a
 * half-written SKILL.md. The temp name is not hidden, so a crash between the
 * two steps leaves something visible rather than another dotfile in a tree
 * where dotfiles mean something to Hermes.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
	const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
	try {
		await writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		const message = err instanceof Error ? err.message : String(err);
		throw new SkillsFsError(500, `Écriture impossible : ${message}`, 'skill_write_failed');
	}
}

function checkSize(content: string): void {
	if (typeof content !== 'string') {
		throw new SkillsFsError(400, 'Le contenu doit être une chaîne.', 'invalid_body');
	}
	if (utf8Length(content) > MAX_SKILL_BYTES) {
		throw new SkillsFsError(
			413,
			`Contenu trop volumineux (max ${formatBytes(MAX_SKILL_BYTES)}).`,
			'skill_too_large'
		);
	}
}

export async function writeSkillFile(ref: SkillRef, content: string): Promise<SkillFileEntry> {
	checkSize(content);
	const root = await skillsRoot();
	const path = await resolveFile(root, ref);
	await writeAtomic(path, content);

	const info = await stat(path);
	return {
		category: ref.category,
		skill: ref.skill ?? null,
		file: ref.file,
		size: info.size,
		modified: Math.floor(info.mtimeMs / 1000)
	};
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateSkillInput {
	category: string;
	name: string;
	description?: string;
	content?: string;
}

/**
 * Create `<category>/<name>/SKILL.md`, and the category (with a
 * DESCRIPTION.md) when it does not exist yet. Never overwrites: an existing
 * skill directory is a 409, so a typo cannot clobber a skill the user spent
 * an evening on.
 */
export async function createSkill(input: CreateSkillInput): Promise<SkillFileEntry> {
	if (!isValidSkillName(input.category) || !isValidSkillName(input.name)) {
		throw new SkillsFsError(
			400,
			'Les noms doivent être en minuscules, chiffres et tirets (ex. : ma-veille-tech).',
			'invalid_skill_path'
		);
	}
	const content = input.content?.trim()
		? input.content
		: skillTemplate(input.name, input.description?.trim() ?? '');
	checkSize(content);

	const root = await skillsRoot();

	// Category: reuse it if it is a real directory inside the root, create it
	// otherwise. `mkdir` without `recursive` fails loudly on a dangling symlink.
	const categoryPath = join(root, input.category);
	let categoryReal: string;
	const categoryInfo = await stat(categoryPath).catch(() => null);
	const freshCategory = !categoryInfo;
	if (freshCategory) {
		await mkdir(categoryPath).catch((err) => {
			throw new SkillsFsError(
				500,
				`Création de la catégorie impossible : ${err instanceof Error ? err.message : err}`,
				'skill_write_failed'
			);
		});
	} else if (!categoryInfo.isDirectory()) {
		throw new SkillsFsError(400, "Cette catégorie n'est pas un répertoire.", 'invalid_skill_path');
	}
	categoryReal = await resolveDir(root, [input.category]);

	const skillPath = join(categoryReal, input.name);
	if (await stat(skillPath).catch(() => null)) {
		throw new SkillsFsError(409, 'Un skill porte déjà ce nom dans cette catégorie.', 'skill_exists');
	}
	await mkdir(skillPath).catch((err) => {
		throw new SkillsFsError(
			500,
			`Création du skill impossible : ${err instanceof Error ? err.message : err}`,
			'skill_write_failed'
		);
	});

	await writeAtomic(join(skillPath, SKILL_FILE), content);

	// A brand-new category with no DESCRIPTION.md would be invisible to the
	// rest of Hermes' tooling; give it the same template treatment.
	if (freshCategory) {
		await writeAtomic(join(categoryReal, DESCRIPTION_FILE), categoryTemplate(input.category));
	}

	const info = await stat(join(skillPath, SKILL_FILE));
	return {
		category: input.category,
		skill: input.name,
		file: SKILL_FILE,
		size: info.size,
		modified: Math.floor(info.mtimeMs / 1000)
	};
}

// ---------------------------------------------------------------------------
// Route glue
// ---------------------------------------------------------------------------

/** Read a `SkillRef` out of query parameters, without trusting any of it. */
export function refFromParams(params: URLSearchParams): SkillRef {
	const skill = params.get('skill');
	return {
		category: params.get('category') ?? '',
		skill: skill || null,
		file: (params.get('file') ?? SKILL_FILE) as EditableFile
	};
}

/**
 * `proxy()` from respond.ts, with this upstream's name on the fallback.
 *
 * The fallback code is deliberately neutral: it catches whatever the
 * filesystem throws that this module did not dress itself, and that happens on
 * reads too. Measured on this Pi — an unreadable skills root answers
 * `GET /api/skills/files` with `EACCES: permission denied, scandir`, which the
 * old `skill_write_failed` labelled as a write that never happened.
 */
export const skillsJson = <T>(fn: () => Promise<T>): Promise<Response> =>
	proxy(fn, { status: 500, code: 'skills_fs_error' });
