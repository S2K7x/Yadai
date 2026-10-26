import { HERMES_API_KEY, HERMES_API_URL, HERMES_SESSION_KEY, REQUEST_TIMEOUT_MS } from './config';
import type {
	HermesCapabilities,
	HermesHealthDetailed,
	HermesJob,
	HermesMessage,
	HermesSession,
	HermesSkill,
	HermesToolset,
	ModelOptions,
	SessionRuntime
} from '$lib/types';
import { AppErrorCode } from '$lib/errors';
import { decodeJson } from '$lib/json';
import { UpstreamError, retrying } from './upstream';
import type { ReasoningModelOptions } from '$lib/reasoning';

/** A gateway failure. Everything a response needs is on `UpstreamError`. */
export class HermesError extends UpstreamError {
	constructor(status: number, message: string, code?: string, retryAfter?: number) {
		super(status, message, code, retryAfter);
		this.name = 'HermesError';
	}
}

interface CallOptions {
	method?: string;
	body?: unknown;
	/** Forwarded so an aborted browser request releases the upstream socket. */
	signal?: AbortSignal;
	headers?: Record<string, string>;
	stream?: boolean;
	/** Per-call timeout override. Streams pass 0 to disable it. */
	timeoutMs?: number;
	/** Retry transient failures. Safe only for reads. */
	retries?: number;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		Authorization: `Bearer ${HERMES_API_KEY}`,
		'X-Hermes-Session-Key': HERMES_SESSION_KEY,
		...extra
	};
}

/**
 * Combine an optional caller signal with a timeout.
 *
 * A read that hangs must not pin a Node socket forever, but the SSE stream is
 * *supposed* to stay open for minutes — hence timeoutMs = 0 there.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
	const signals: AbortSignal[] = [];
	if (signal) signals.push(signal);
	if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
	if (signals.length === 0) return { signal: undefined, timedOut: () => false };

	const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	// `AbortSignal.timeout` aborts with a TimeoutError; distinguishing it from a
	// client disconnect is what lets us report "trop lent" vs. staying silent.
	return {
		signal: combined,
		timedOut: () => signals.some((s) => s.aborted && (s.reason as Error)?.name === 'TimeoutError')
	};
}

/** Raw fetch against the Hermes API server. Callers own the response. */
export async function hermesFetch(path: string, opts: CallOptions = {}): Promise<Response> {
	const headers = authHeaders(opts.headers);
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
	if (opts.stream) headers['Accept'] = 'text/event-stream';

	const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const { signal, timedOut } = withTimeout(opts.signal, timeoutMs);

	try {
		return await fetch(`${HERMES_API_URL}${path}`, {
			method: opts.method || 'GET',
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal
		});
	} catch (err) {
		// The caller aborting is not an error worth dressing up — rethrow so the
		// SSE relay can stay quiet about a user closing a tab.
		if (opts.signal?.aborted) throw err;
		if (timedOut()) {
			throw new HermesError(504, `Hermes did not respond within ${timeoutMs} ms`, AppErrorCode.Timeout);
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new HermesError(502, message, AppErrorCode.Unreachable);
	}
}

/** Error bodies Hermes emits: OpenAI-shaped, or a bare string. */
interface HermesErrorBody {
	error?: string | { message?: string; code?: string };
}

/** One call, decoded, mapping Hermes' errors onto HermesError. */
async function hermesOnce<T>(path: string, opts: CallOptions): Promise<T> {
	const res = await hermesFetch(path, opts);
	const text = await res.text();
	const parsed = decodeJson(text) as HermesErrorBody | null;

	if (!res.ok) {
		const err = parsed?.error;
		const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
		throw new HermesError(
			res.status,
			// Some handlers answer {"error": "..."} instead of the
			// OpenAI-shaped {"error": {"message": ...}}.
			(typeof err === 'string' ? err : err?.message) ||
				text ||
				`Hermes returned HTTP ${res.status}`,
			typeof err === 'object' ? err?.code : undefined,
			retryAfter
		);
	}
	return parsed as T;
}

/**
 * Fetch + JSON decode, with the shared read-only retry.
 *
 * `retries` is opt-in and only ever set on reads: replaying a POST that created
 * a session or started an agent turn would duplicate work.
 */
export function hermesJson<T = unknown>(path: string, opts: CallOptions = {}): Promise<T> {
	return retrying(() => hermesOnce<T>(path, opts), { attempts: (opts.retries ?? 0) + 1 });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const getHealth = () =>
	hermesJson<{ status: string; platform: string; version: string }>('/health', {
		retries: 1,
		timeoutMs: 5000
	});

export const getHealthDetailed = () =>
	hermesJson<HermesHealthDetailed>('/health/detailed', { retries: 1, timeoutMs: 8000 });

export const getCapabilities = () => hermesJson<HermesCapabilities>('/v1/capabilities', { retries: 1 });

export const getModelOptions = () => hermesJson<ModelOptions>('/api/model/options', { retries: 1 });

export const getSkills = () => hermesJson<{ data: HermesSkill[] }>('/v1/skills', { retries: 1 });

export const getToolsets = () => hermesJson<{ data: HermesToolset[] }>('/v1/toolsets', { retries: 1 });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionListQuery {
	limit?: number;
	offset?: number;
	source?: string;
	include_children?: boolean;
}

export function listSessions(q: SessionListQuery = {}) {
	const params = new URLSearchParams();
	params.set('limit', String(q.limit ?? 50));
	params.set('offset', String(q.offset ?? 0));
	if (q.source) params.set('source', q.source);
	if (q.include_children) params.set('include_children', 'true');
	return hermesJson<{
		data: HermesSession[];
		limit: number;
		offset: number;
		has_more: boolean;
	}>(`/api/sessions?${params}`, { retries: 1 });
}

/**
 * Create a session.
 *
 * `model` MUST be a real provider model id (e.g. "openrouter/free"), not the
 * virtual name from /v1/models. Hermes persists whatever is passed onto the
 * session row and then feeds it back to the provider verbatim; posting the
 * virtual "hermes-agent" makes every turn fail with
 * `HTTP 400: hermes-agent is not a valid model ID`. Callers resolve the
 * default from /api/model/options.model.
 */
export function createSession(body: {
	title?: string;
	model?: string;
	system_prompt?: string;
	source?: string;
}) {
	return hermesJson<{ session: HermesSession }>('/api/sessions', { method: 'POST', body });
}

export const getSession = (id: string) =>
	hermesJson<{ session: HermesSession }>(`/api/sessions/${encodeURIComponent(id)}`, { retries: 1 });

/** Only title / pinned / archived / end_reason are accepted upstream. */
export const patchSession = (
	id: string,
	body: { title?: string | null; pinned?: boolean; archived?: boolean; end_reason?: string }
) =>
	hermesJson<{ session: HermesSession }>(`/api/sessions/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body
	});

export const deleteSession = (id: string) =>
	hermesJson<{ id: string; deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
		method: 'DELETE'
	});

export const getSessionMessages = (
	id: string,
	q: { limit?: number; offset?: number; order?: 'oldest' | 'latest' } = {}
) => {
	const params = new URLSearchParams();
	if (q.limit !== undefined) params.set('limit', String(q.limit));
	if (q.offset !== undefined) params.set('offset', String(q.offset));
	if (q.order) params.set('order', q.order);
	const qs = params.toString();
	return hermesJson<{
		session_id: string;
		data: HermesMessage[];
		pagination: Record<string, unknown>;
	}>(`/api/sessions/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ''}`, { retries: 1 });
};

/** Branch a session. Upstream marks the parent `end_reason = "branched"`. */
export const forkSession = (id: string, body: { title?: string; id?: string } = {}) =>
	hermesJson<{ session: HermesSession }>(`/api/sessions/${encodeURIComponent(id)}/fork`, {
		method: 'POST',
		body
	});

/**
 * Re-pin the model of an EXISTING session.
 *
 * Verified against `_handle_session_model_lock` in api_server.py: the handler
 * forces `require_model_lock`, persists a confirmed `browser_model_lock` in
 * the session's `model_config`, and updates the `model` column
 * (`model = COALESCE(?, model)`). Every later turn resolves its runtime
 * through `_effective_session_runtime_request`, where a confirmed lock wins
 * over the session row — so the switch applies to the open conversation, not
 * only to the next one.
 *
 * A model the gateway cannot route is refused with 409
 * `model_lock_unavailable` rather than silently falling back to the global
 * default, which is why this must not be retried blindly.
 */
export const setSessionModel = (id: string, body: { model: string; provider?: string }) =>
	hermesJson<{ object: string; session_id: string; runtime: SessionRuntime }>(
		`/api/sessions/${encodeURIComponent(id)}/model`,
		{ method: 'POST', body }
	);

/**
 * SSE turn. Returns the raw upstream Response for the relay to pipe.
 *
 * `model_options` is how a turn asks for a reasoning effort: upstream reads
 * `model_options.reasoning.{enabled,effort}` out of this body on every request
 * and never stores it, so it has to be re-sent each time (see
 * `src/lib/reasoning.ts`). It carries no model — sending one here would be a
 * per-turn model override, which is not what this field is for.
 */
export const sessionChatStream = (
	id: string,
	body: { message: unknown; system_message?: string; model_options?: ReasoningModelOptions },
	signal?: AbortSignal
) =>
	hermesFetch(`/api/sessions/${encodeURIComponent(id)}/chat/stream`, {
		method: 'POST',
		body,
		signal,
		stream: true,
		// An agent turn legitimately runs for many minutes; the only thing that
		// should end it is the agent, the user, or a dead socket.
		timeoutMs: 0
	});

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

/**
 * List cron jobs.
 *
 * `include_disabled` is not cosmetic: measured against 0.20.0, pausing a job
 * clears `enabled` and `_cron_list()` drops it from the default listing — the
 * row would vanish from the panel the moment the user paused it. The panel
 * always asks for the full set and renders the paused state itself.
 */
export const listJobs = (includeDisabled = true) =>
	hermesJson<{ jobs: HermesJob[] }>(
		`/api/jobs${includeDisabled ? '?include_disabled=true' : ''}`,
		{ retries: 1 }
	);

export interface CreateJobBody {
	name: string;
	schedule: string;
	prompt: string;
	deliver?: string;
}

/**
 * Create a cron job.
 *
 * Never retried — a replayed POST is a second job on the schedule. Note that an
 * unparseable `schedule` comes back as HTTP 500 with the ValueError text, not a
 * 400: `_handle_create_job` only validates name/prompt itself and lets
 * `parse_schedule` raise into the generic handler. The browser validates the
 * schedule first (`parseSchedule` in `$lib/jobs`) so that path stays rare.
 */
export const createJob = (body: CreateJobBody) =>
	hermesJson<{ job: HermesJob }>('/api/jobs', { method: 'POST', body });

/**
 * Edit a job in place.
 *
 * `_UPDATE_ALLOWED_FIELDS` upstream is {name, schedule, prompt, deliver, skills,
 * skill, repeat, enabled} — anything else is silently dropped, and a body with
 * no allowed field at all answers 400. `schedule` may be sent as a raw string:
 * `update_job` re-parses it and recomputes `next_run_at` itself (verified in
 * cron/jobs.py 0.20.0), which is why the panel never has to touch that field.
 */
export const updateJob = (
	id: string,
	body: { name?: string; schedule?: string; prompt?: string; deliver?: string }
) =>
	hermesJson<{ job: HermesJob }>(`/api/jobs/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body
	});

export const deleteJob = (id: string) =>
	hermesJson<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const jobAction = (id: string, action: 'pause' | 'resume' | 'run') =>
	hermesJson<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
		method: 'POST',
		body: {}
	});
