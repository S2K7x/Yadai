/**
 * Skill files on disk — pure logic, shared by the proxy and the browser.
 *
 * Hermes keeps skills as `<skills dir>/<category>/<skill>/SKILL.md`, with one
 * `DESCRIPTION.md` per category. This module knows that layout and nothing
 * else: no `fs`, no `$lib/server`, so `node --test` can import it directly.
 *
 * Everything the editor writes goes through `skillSegments()`. It is the only
 * place that turns caller-supplied strings into path components, and it is
 * deliberately strict — the alternative is path traversal into a directory
 * whose contents Hermes feeds to an agent holding a terminal.
 */

import { includesFolded, searchNeedle, slugify } from './text.ts';

/** Skill and category names, as Hermes' own tree uses them. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Long enough for `autonomous-ai-agents`, short enough to stay a directory. */
export const MAX_NAME_LENGTH = 64;

/**
 * Ceiling on a file the editor will open or write, in bytes.
 *
 * A SKILL.md is prose; anything past this is a mistake (a pasted binary, a
 * runaway generation) and loading it into a textarea on a Pi is not free.
 */
export const MAX_SKILL_BYTES = 256 * 1024;

export const SKILL_FILE = 'SKILL.md';
export const DESCRIPTION_FILE = 'DESCRIPTION.md';

/** The only two filenames this editor may read or write. */
export type EditableFile = typeof SKILL_FILE | typeof DESCRIPTION_FILE;

/** A file the editor can address: a skill's SKILL.md, or a category's DESCRIPTION.md. */
export interface SkillRef {
	category: string;
	/** null for a category-level DESCRIPTION.md. */
	skill?: string | null;
	file: EditableFile;
}

/** A row in the skills list. */
export interface SkillFileEntry extends SkillRef {
	skill: string | null;
	/** Bytes on disk. */
	size: number;
	/** Unix seconds, matching `relativeTime()` in sessions.ts. */
	modified: number;
}

export function isValidSkillName(name: unknown): name is string {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name.length <= MAX_NAME_LENGTH &&
		SKILL_NAME_RE.test(name)
	);
}

export function isEditableFile(file: unknown): file is EditableFile {
	return file === SKILL_FILE || file === DESCRIPTION_FILE;
}

/**
 * Path components for a reference, relative to the skills root — or null when
 * the reference is not one this editor is allowed to touch.
 *
 * Rejects by construction: traversal (`..`), absolute paths, separators,
 * hidden files (`.bundled_manifest`, `.curator_state` — Hermes' own state,
 * never ours to read or write), any filename other than the two above, and
 * SKILL.md outside a skill directory or DESCRIPTION.md inside one.
 */
export function skillSegments(ref: SkillRef): string[] | null {
	if (!isValidSkillName(ref.category)) return null;
	if (!isEditableFile(ref.file)) return null;

	const skill = ref.skill ?? null;
	if (skill !== null && !isValidSkillName(skill)) return null;

	// A category describes itself; a skill is described by its SKILL.md.
	if (ref.file === DESCRIPTION_FILE && skill !== null) return null;
	if (ref.file === SKILL_FILE && skill === null) return null;

	return skill === null ? [ref.category, ref.file] : [ref.category, skill, ref.file];
}

/** Byte length of the UTF-8 encoding, which is what the size cap counts. */
export function utf8Length(content: string): number {
	return new TextEncoder().encode(content).length;
}

/**
 * Best-effort directory name from whatever the user typed in the create form.
 *
 * Accents are folded rather than dropped so "Résumé d'articles" becomes
 * `resume-d-articles` instead of `r-sum-d-articles`.
 */
export function slugifySkillName(input: string): string {
	return slugify(input, MAX_NAME_LENGTH);
}

/** Starting point for a new SKILL.md: valid frontmatter, obvious blanks. */
export function skillTemplate(name: string, description = ''): string {
	return `---
name: ${name}
description: ${description || 'À compléter — dis en une phrase quand Yadai doit charger ce skill.'}
---

# ${name}

## Quand l'utiliser

Décris les situations qui déclenchent ce skill.

## Marche à suivre

1. Première étape.
2. Deuxième étape.

## Pièges

- Ce qu'il ne faut surtout pas faire.
`;
}

/** Starting point for a new category's DESCRIPTION.md. */
export function categoryTemplate(category: string): string {
	return `# ${category}

À compléter : ce que regroupe cette catégorie de skills.
`;
}

export interface SkillCategoryGroup {
	category: string;
	/** The category's DESCRIPTION.md, when it has one. */
	description: SkillFileEntry | null;
	skills: SkillFileEntry[];
}

/**
 * Group a flat listing by category, keeping a category visible as long as one
 * of its rows matches the query (so searching a skill name still shows where
 * it lives), and dropping empty categories.
 */
export function groupSkillFiles(entries: SkillFileEntry[], query = ''): SkillCategoryGroup[] {
	const groups = new Map<string, SkillCategoryGroup>();
	for (const entry of entries) {
		let group = groups.get(entry.category);
		if (!group) {
			group = { category: entry.category, description: null, skills: [] };
			groups.set(entry.category, group);
		}
		if (entry.file === DESCRIPTION_FILE) group.description = entry;
		else group.skills.push(entry);
	}

	const needle = searchNeedle(query);
	const result: SkillCategoryGroup[] = [];
	for (const group of groups.values()) {
		if (!needle) {
			result.push(group);
			continue;
		}
		if (includesFolded(group.category, needle)) {
			result.push(group);
			continue;
		}
		const skills = group.skills.filter((s) => includesFolded(s.skill, needle));
		if (skills.length) result.push({ ...group, skills });
	}

	result.sort((a, b) => a.category.localeCompare(b.category, 'fr'));
	for (const group of result) {
		group.skills.sort((a, b) => (a.skill ?? '').localeCompare(b.skill ?? '', 'fr'));
	}
	return result;
}

/** Stable identity for a row, usable as a keyed-each key. */
export function skillKey(ref: SkillRef): string {
	return `${ref.category}/${ref.skill ?? ''}/${ref.file}`;
}

/** Human label for a row. */
export function skillLabel(ref: SkillRef): string {
	return ref.skill ?? `${ref.category} (description)`;
}
