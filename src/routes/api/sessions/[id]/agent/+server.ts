import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bindSessionAgent, findAgent, sessionAgentId } from '$lib/server/agents';
import { errorResponse, gate, readJson } from '$lib/server/respond';

/**
 * Put an open conversation under a different agent.
 *
 * Nothing is sent to Hermes: the binding is local, and the persona reaches the
 * gateway through `system_message` on the next turn (see the stream route). So
 * the change applies from the next message, the same way a model lock does —
 * and the transcript already written keeps whatever produced it.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const limited = gate('agents-write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<{ agent_id?: unknown }>(request);
	if ('response' in parsed) return parsed.response;

	const raw = parsed.body.agent_id;
	// null clears the binding: back to Hermes' own default prompt.
	if (raw === null || raw === '') {
		bindSessionAgent(params.id, null);
		return json({ session_id: params.id, agent_id: null });
	}
	if (typeof raw !== 'string') {
		return errorResponse(400, '`agent_id` must be a string or null.', 'invalid_body');
	}
	if (!findAgent(raw)) {
		return errorResponse(404, 'This agent no longer exists.', 'agent_not_found');
	}

	bindSessionAgent(params.id, raw);
	return json({ session_id: params.id, agent_id: sessionAgentId(params.id) });
};
