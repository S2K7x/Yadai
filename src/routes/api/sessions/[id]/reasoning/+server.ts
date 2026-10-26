import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionReasoning, setSessionReasoning } from '$lib/server/reasoning';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { normalizeReasoning, REASONING_EFFORTS } from '$lib/reasoning';

/**
 * Choose how hard this conversation thinks.
 *
 * Nothing is sent to Hermes: like the agent binding, the value is local and
 * reaches the gateway as `model_options` on the next turn (see the stream
 * route). So it applies from the next message, and what is already in the
 * transcript keeps the effort that produced it.
 *
 * An unknown effort is refused rather than quietly normalised to `auto`:
 * upstream *ignores* a level it does not know, which would leave the caller
 * believing it had asked for something.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const limited = gate('sessions:write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<{ reasoning?: unknown }>(request);
	if ('response' in parsed) return parsed.response;

	const raw = parsed.body.reasoning;
	// null and '' mean "no opinion": back to Hermes' own configured effort.
	const wanted = raw === null || raw === '' || raw === undefined ? 'auto' : raw;
	if (typeof wanted !== 'string' || normalizeReasoning(wanted) !== wanted.trim().toLowerCase()) {
		return errorResponse(
			400,
			`\`reasoning\` must be one of ${REASONING_EFFORTS.join(', ')} or null.`,
			'invalid_body'
		);
	}

	setSessionReasoning(params.id, normalizeReasoning(wanted));
	return json({ session_id: params.id, reasoning: sessionReasoning(params.id) });
};
