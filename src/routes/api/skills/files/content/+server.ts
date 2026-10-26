import type { RequestHandler } from './$types';
import { invalidateSkillCatalogue } from '$lib/server/catalog';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { readSkillFile, refFromParams, skillsJson, writeSkillFile } from '$lib/server/skills';
import { SKILL_FILE, type EditableFile } from '$lib/skills';

/** Read one SKILL.md / DESCRIPTION.md. */
export const GET: RequestHandler = async ({ url }) => {
	const limited = gate('skills-fs-read', 4, 12);
	if (limited) return limited;
	return skillsJson(() => readSkillFile(refFromParams(url.searchParams)));
};

interface WriteBody {
	category?: unknown;
	skill?: unknown;
	file?: unknown;
	content?: unknown;
}

/**
 * Replace one file's contents. No PATCH and no delete: this editor only ever
 * overwrites a file the user is looking at, and removing a skill stays a
 * command-line decision.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const limited = gate('skills-fs-write', 1, 6);
	if (limited) return limited;

	const parsed = await readJson<WriteBody>(request);
	if ('response' in parsed) return parsed.response;
	const { category, skill, file, content } = parsed.body;

	// Explicit, because the fallback would be an empty string — i.e. a
	// malformed request would truncate the file it meant to edit.
	if (typeof content !== 'string') {
		return errorResponse(400, 'The "content" field must be a string.', 'invalid_body');
	}

	return skillsJson(async () => {
		const written = await writeSkillFile(
			{
				category: String(category ?? ''),
				skill: typeof skill === 'string' && skill ? skill : null,
				file: (typeof file === 'string' ? file : SKILL_FILE) as EditableFile
			},
			content
		);
		// Same reason as creating one: the description this listing carries is
		// read from the file that has just been rewritten.
		invalidateSkillCatalogue();
		return written;
	});
};
