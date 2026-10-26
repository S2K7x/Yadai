import type { RequestHandler } from './$types';
import { setSessionModel } from '$lib/server/hermes';
import { errorResponse, gate, proxy, readJson } from '$lib/server/respond';

/**
 * Re-pin the model of an open conversation.
 *
 * Hermes persists a confirmed model lock on the session row; the next turn of
 * THIS session already uses it. Not a PATCH: upstream only accepts
 * title / pinned / archived / end_reason there.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const limited = gate('sessions:write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<{ model?: unknown; provider?: unknown }>(request);
	if ('response' in parsed) return parsed.response;

	const model = typeof parsed.body.model === 'string' ? parsed.body.model.trim() : '';
	if (!model) {
		return errorResponse(400, 'A model id is required.', 'missing_model');
	}
	const provider = typeof parsed.body.provider === 'string' ? parsed.body.provider.trim() : '';

	return proxy(() => setSessionModel(params.id, { model, provider: provider || undefined }));
};
