import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgents, saveAgent } from '$lib/server/agents';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { agentFromDraft, agentSlug, draftFromBody, validateAgent } from '$lib/agents';

/**
 * The agent roster.
 *
 * Nothing here talks to Hermes — a persona is this app's own state, and the
 * gateway has no endpoint for one. The rules live in `$lib/agents` so the same
 * `validateAgent()` guards the form and the database.
 */

/** A slug not already taken by another agent. */
function freeId(name: string, taken: Set<string>): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const candidate = agentSlug(name, Math.random().toString(36).slice(2, 6));
		if (!taken.has(candidate)) return candidate;
	}
	return `agent-${Date.now().toString(36)}`;
}

export const GET: RequestHandler = () => {
	const limited = gate('agents-read', 4, 12);
	if (limited) return limited;
	return json({ agents: listAgents() });
};

export const POST: RequestHandler = async ({ request }) => {
	const limited = gate('agents-write', 2, 8);
	if (limited) return limited;

	const parsed = await readJson<Record<string, unknown>>(request);
	if ('response' in parsed) return parsed.response;

	const list = listAgents();
	const draft = draftFromBody(parsed.body);
	const errors = validateAgent(list, null, draft);
	if (errors.length > 0) return errorResponse(400, errors.join(' '), 'invalid_agent');

	const agent = agentFromDraft(draft, freeId(draft.name, new Set(list.map((a) => a.id))), 0);
	if (!agent) return errorResponse(400, 'This agent could not be saved.', 'invalid_agent');

	saveAgent(agent);
	return json({ agent, agents: listAgents() });
};
