import db from './db';
import { findAgent, listAgents } from './agents';
import { errorResponse } from './respond';
import { composeSystemPrompt } from '$lib/agents';
import { MAX_JOB_NAME, composeJobPrompt, jobInstructionLimit, parseSchedule } from '$lib/jobs';
import type { HermesJob } from '$lib/types';

/**
 * Which agent owns which scheduled task, and what the user actually typed.
 *
 * Hermes' cron stores one prompt per job and nothing else — no persona, no
 * model (`_handle_create_job` in api_server.py 0.20.0 forwards name, schedule,
 * prompt, deliver, skills and repeat, full stop). Running a task "as an agent"
 * therefore means baking the agent's card into that prompt, which loses the
 * distinction between the card and the instruction the moment it is written.
 *
 * This table keeps that distinction on our side: `agent_id` so the panel can
 * show whose task it is, and `instruction` so reopening a task for editing
 * shows what was typed instead of the composed blob. Both are UI state, exactly
 * like the saved prompt library — Hermes stays the authority on the schedule
 * itself and on the prompt it will actually run.
 */

db.exec(`
	CREATE TABLE IF NOT EXISTS job_meta (
		job_id      TEXT PRIMARY KEY,
		agent_id    TEXT,
		instruction TEXT NOT NULL DEFAULT '',
		updated_at  REAL NOT NULL
	);
`);

const upsertMeta = db.prepare(
	`INSERT INTO job_meta (job_id, agent_id, instruction, updated_at) VALUES (?, ?, ?, ?)
	 ON CONFLICT(job_id) DO UPDATE SET
	   agent_id = excluded.agent_id,
	   instruction = excluded.instruction,
	   updated_at = excluded.updated_at`
);
const selMeta = db.prepare<[string], JobMetaRow>(
	'SELECT job_id, agent_id, instruction FROM job_meta WHERE job_id = ?'
);
const allMeta = db.prepare('SELECT job_id, agent_id, instruction FROM job_meta');
const delMeta = db.prepare('DELETE FROM job_meta WHERE job_id = ?');

interface JobMetaRow {
	job_id: string;
	agent_id: string | null;
	instruction: string;
}

export interface JobMeta {
	agentId: string | null;
	instruction: string;
}

export function rememberJob(jobId: string, agentId: string | null, instruction: string): void {
	upsertMeta.run(jobId, agentId || null, instruction, Date.now() / 1000);
}

export function jobMeta(jobId: string): JobMeta | null {
	const row = selMeta.get(jobId);
	return row ? { agentId: row.agent_id, instruction: row.instruction } : null;
}

export function forgetJob(jobId: string): void {
	delMeta.run(jobId);
}

/**
 * Drop rows for jobs that no longer exist upstream.
 *
 * A task can be deleted from the CLI or by the scheduler retiring a completed
 * one-shot, and nothing tells this app about it. Only ever called with a list
 * that came back non-empty: an upstream hiccup answering "no jobs" must not be
 * allowed to erase every binding.
 */
export function pruneJobMeta(knownIds: string[]): void {
	if (knownIds.length === 0) return;
	const keep = new Set(knownIds);
	const stale = (allMeta.all() as JobMetaRow[]).filter((row) => !keep.has(row.job_id));
	if (stale.length === 0) return;
	const drop = db.transaction((rows: JobMetaRow[]) => {
		for (const row of rows) delMeta.run(row.job_id);
	});
	drop(stale);
}

/**
 * The prompt to store upstream for a task, given its agent.
 *
 * Returns the instruction untouched when the agent is gone or none was chosen,
 * so a deleted agent degrades to "runs on Hermes' default prompt" instead of
 * breaking the task.
 */
export function jobPromptFor(agentId: string | null, instruction: string): string {
	if (!agentId) return instruction.trim();
	return composeJobPrompt(composeSystemPrompt(listAgents(), agentId), instruction).prompt;
}

// ---------------------------------------------------------------------------
// Validating what the panel sends
// ---------------------------------------------------------------------------

export interface JobBody {
	name?: unknown;
	schedule?: unknown;
	instruction?: unknown;
	agentId?: unknown;
	deliver?: unknown;
}

export interface ValidJobInput {
	name: string;
	schedule: string;
	instruction: string;
	agentId: string | null;
	deliver: string;
}

/**
 * Everything a task needs, validated — or the response saying what is wrong.
 *
 * Shared by creation and edition so both doors apply the same bounds. The
 * schedule is checked here as well as in the browser: upstream turns an
 * unparseable one into an opaque HTTP 500 (`parse_schedule` raises into the
 * handler's bare `except`), and this is the last place that can still say why
 * in French.
 */
export function readJobInput(body: JobBody): ValidJobInput | Response {
	const name = String(body.name ?? '').trim();
	const schedule = String(body.schedule ?? '').trim();
	const instruction = String(body.instruction ?? '').trim();
	const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null;
	const deliver = String(body.deliver ?? 'local').trim() || 'local';

	if (!name) return errorResponse(400, 'Give the task a name.', 'invalid_job');
	if (name.length > MAX_JOB_NAME) {
		return errorResponse(400, `The name exceeds ${MAX_JOB_NAME} characters.`, 'invalid_job');
	}
	if (!instruction) return errorResponse(400, 'Describe what Hermes should do.', 'invalid_job');

	// An agent's card is baked into the prompt, so it eats into the upstream
	// 5 000-character budget: the ceiling is not the same with and without one.
	const agent = agentId ? findAgent(agentId) : undefined;
	if (agentId && !agent) return errorResponse(400, 'This agent no longer exists.', 'invalid_job');

	const limit = jobInstructionLimit(Boolean(agent));
	if (instruction.length > limit) {
		return errorResponse(400, `The instruction exceeds ${limit} characters.`, 'invalid_job');
	}

	const check = parseSchedule(schedule);
	if (check.kind === null) return errorResponse(400, check.error, 'invalid_schedule');

	return { name, schedule, instruction, agentId: agent ? agentId : null, deliver };
}

/**
 * Decorate the upstream job list with what this app knows about it.
 *
 * `agent_id` and `instruction` are ours, not Hermes' — same arrangement as
 * `agent_id` on a session row. `persona_stale` compares the prompt Hermes holds
 * with the one the current roster would produce: it is true exactly when the
 * agent's card was edited after the task was planned, which is the only moment
 * the panel has anything useful to offer ("mettre à jour la fiche").
 */
export function decorateJobs(jobs: HermesJob[]): HermesJob[] {
	const rows = allMeta.all() as JobMetaRow[];
	if (rows.length === 0) return jobs;

	const byId = new Map(rows.map((row) => [row.job_id, row]));
	const agents = listAgents();
	const known = new Set(agents.map((a) => a.id));
	const personas = new Map<string, string>();

	return jobs.map((job) => {
		const meta = typeof job.id === 'string' ? byId.get(job.id) : undefined;
		if (!meta) return job;

		const agentId = meta.agent_id && known.has(meta.agent_id) ? meta.agent_id : null;
		let stale = false;
		if (agentId && meta.instruction) {
			if (!personas.has(agentId)) personas.set(agentId, composeSystemPrompt(agents, agentId));
			const expected = composeJobPrompt(personas.get(agentId)!, meta.instruction).prompt;
			stale = expected !== job.prompt;
		}
		return {
			...job,
			agent_id: agentId,
			instruction: meta.instruction,
			persona_stale: stale
		};
	});
}
