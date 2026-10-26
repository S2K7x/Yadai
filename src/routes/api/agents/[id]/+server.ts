import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgents, removeAgent, saveAgent } from '$lib/server/agents';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { agentFromDraft, draftFromBody, validateAgent } from '$lib/agents';

/** Edit or delete one agent. Both answer with the whole roster: deleting an
 *  agent also removes it from every team that mentioned it. */

export const PATCH: RequestHandler = async ({ params, request }) => {
	const limited = gate('agents-write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<Record<string, unknown>>(request);
	if ('response' in parsed) return parsed.response;

	const list = listAgents();
	const existing = list.find((a) => a.id === params.id);
	if (!existing) return errorResponse(404, 'This agent no longer exists.', 'agent_not_found');

	const draft = draftFromBody(parsed.body);
	const errors = validateAgent(list, existing.id, draft);
	if (errors.length > 0) return errorResponse(400, errors.join(' '), 'invalid_agent');

	const agent = agentFromDraft(draft, existing.id, existing.created_at);
	if (!agent) return errorResponse(400, 'This agent could not be saved.', 'invalid_agent');

	saveAgent(agent);
	return json({ agent, agents: listAgents() });
};

export const DELETE: RequestHandler = ({ params }) => {
	const limited = gate('agents-write', 2, 8);
	if (limited) return limited;

	if (!removeAgent(params.id)) {
		return errorResponse(404, 'This agent no longer exists.', 'agent_not_found');
	}
	return json({ agents: listAgents() });
};
