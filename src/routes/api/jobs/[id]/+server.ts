import type { RequestHandler } from './$types';
import { deleteJob, jobAction, updateJob } from '$lib/server/hermes';
import {
	forgetJob,
	jobPromptFor,
	readJobInput,
	rememberJob,
	type JobBody
} from '$lib/server/jobs';
import { errorResponse, gate, proxy, readJson } from '$lib/server/respond';

const ACTIONS = new Set(['pause', 'resume', 'run']);

/** `_JOB_ID_RE` upstream: 12 lowercase hex characters, nothing else. */
const JOB_ID_RE = /^[a-f0-9]{12}$/;

function badId(id: string): Response | null {
	return JOB_ID_RE.test(id)
		? null
		: errorResponse(400, 'Invalid task id.', 'invalid_job_id');
}

interface ActionBody {
	action?: unknown;
}

/** Pause / resume / run now. `run` fires the job immediately, out of schedule. */
export const POST: RequestHandler = async ({ params, request }) => {
	const limited = gate('jobs-write', 1, 5);
	if (limited) return limited;

	const invalid = badId(params.id);
	if (invalid) return invalid;

	const parsed = await readJson<ActionBody>(request);
	if ('response' in parsed) return parsed.response;

	const action = String(parsed.body.action ?? '');
	if (!ACTIONS.has(action)) return errorResponse(400, 'Unknown action.', 'invalid_job_action');

	return proxy(() => jobAction(params.id, action as 'pause' | 'resume' | 'run'));
};

/**
 * Edit a task: name, schedule, instruction, agent and delivery in one go.
 *
 * The whole form is always sent, never a subset. Two reasons: the prompt has to
 * be recomposed from the instruction *and* the agent whenever either moves, and
 * upstream's `PATCH` answers 400 when a body carries no allowed field at all —
 * a partial update would be one more shape to get wrong for no gain.
 *
 * This is also the path behind "mettre à jour la fiche" when an agent's card
 * has been edited since: same values in, freshly composed prompt out.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const limited = gate('jobs-write', 1, 5);
	if (limited) return limited;

	const invalid = badId(params.id);
	if (invalid) return invalid;

	const parsed = await readJson<JobBody>(request);
	if ('response' in parsed) return parsed.response;

	const input = readJobInput(parsed.body);
	if (input instanceof Response) return input;

	return proxy(async () => {
		const updated = await updateJob(params.id, {
			name: input.name,
			schedule: input.schedule,
			prompt: jobPromptFor(input.agentId, input.instruction),
			deliver: input.deliver
		});
		rememberJob(params.id, input.agentId, input.instruction);
		return {
			job: { ...updated.job, agent_id: input.agentId, instruction: input.instruction }
		};
	});
};

export const DELETE: RequestHandler = async ({ params }) => {
	const limited = gate('jobs-write', 1, 5);
	if (limited) return limited;

	const invalid = badId(params.id);
	if (invalid) return invalid;

	return proxy(async () => {
		const done = await deleteJob(params.id);
		// Only after upstream confirms: forgetting the binding of a job that is
		// still scheduled would leave it orphaned in the panel.
		forgetJob(params.id);
		return done;
	});
};
