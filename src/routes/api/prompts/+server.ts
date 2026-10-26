import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPref, setPref } from '$lib/server/db';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { normalizePrompts } from '$lib/prompts';

/**
 * The saved-prompt library, stored in this app's own prefs table.
 *
 * Nothing here talks to Hermes: a prompt library is UI state, and Hermes has
 * no endpoint for it. Keeping it server-side instead of in localStorage is
 * what makes a prompt saved on the desktop show up on the phone.
 */

const KEY = 'saved_prompts';

export const GET: RequestHandler = () => {
	const limited = gate('prompts-read', 4, 12);
	if (limited) return limited;
	return json({ prompts: normalizePrompts(getPref(KEY, [])) });
};

export const PUT: RequestHandler = async ({ request }) => {
	const limited = gate('prompts-write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<{ prompts?: unknown }>(request);
	if ('response' in parsed) return parsed.response;
	// A body without a list would normalise to [] — that is, it would erase the
	// library. Refuse it instead: only a real list may replace one.
	if (!Array.isArray(parsed.body.prompts)) {
		return errorResponse(400, '`prompts` must be a list.', 'invalid_body');
	}

	// Normalising server-side is what bounds the row. The browser is trusted
	// here, but a bug in it must not be able to grow the prefs blob without
	// limit, and the response is what the client adopts as truth.
	const prompts = normalizePrompts(parsed.body.prompts);
	setPref(KEY, prompts);
	return json({ prompts });
};
