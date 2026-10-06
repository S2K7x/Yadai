import { HERMES_DASHBOARD_TOKEN, HERMES_DASHBOARD_URL, REQUEST_TIMEOUT_MS } from './config';
import { proxy } from './respond';
import { UpstreamError, retrying } from './upstream';
import { invalidateModelOptions } from './catalog';
import { decodeJson } from '$lib/json';
import type { SystemStats } from '$lib/system';
import type {
	EnvVarMap,
	OauthPollResponse,
	OauthProvider,
	OauthStartResponse,
	ValidationResult
} from '$lib/providers';

/**
 * Client for Hermes' dashboard API (`hermes_cli/web_server.py`), the second
 * server on this host — 127.0.0.1:9119, its own token, its own concerns.
 *
 * Built on the same rules as `hermes.ts`: a timeout on every call, retries
 * only on reads, and one typed error class so routes never have to read an
 * upstream body. Two things are specific to this one:
 *
 * 1. **The token never leaves the server.** It travels in
 *    `X-Hermes-Session-Token` on outbound calls and appears in no response.
 * 2. **No credential value is ever logged or echoed back.** The dashboard hands
 *    out `redacted_value`; `/api/env/reveal` exists upstream and is
 *    deliberately not proxied.
 *
 * When `HERMES_DASHBOARD_TOKEN` is unset every call raises
 * `dashboard_disabled` and the providers panel turns itself off, exactly the
 * way an unmounted `SKILLS_DIR` disables the skills editor.
 */

/** A dashboard failure. `code` is always one of DashboardErrorCode below. */
export class DashboardError extends UpstreamError {
	constructor(status: number, message: string, code: string) {
		super(status, message, code);
		this.name = 'DashboardError';
	}
}

export const DashboardErrorCode = {
	Disabled: 'dashboard_disabled',
	Unreachable: 'dashboard_unreachable',
	Timeout: 'dashboard_timeout',
	Unauthorized: 'dashboard_unauthorized',
	Failed: 'dashboard_error'
} as const;

const DISABLED_MESSAGE =
	'La gestion des providers est désactivée : HERMES_DASHBOARD_TOKEN n\'est pas configuré.';

/** Is the feature usable at all? Drives the panel's on/off, never throws. */
export function dashboardConfigured(): boolean {
	return HERMES_DASHBOARD_TOKEN.length > 0 && HERMES_DASHBOARD_URL.length > 0;
}

interface CallOptions {
	method?: string;
	body?: unknown;
	timeoutMs?: number;
	/** Retry transient failures. Reads only — a PUT here writes a credential. */
	retries?: number;
}

/**
 * One call against the dashboard, decoded, with the shared read-only retry.
 *
 * FastAPI reports failures as `{"detail": "..."}`; those messages are about
 * names and reachability, never about the value that was sent, so they are
 * safe to pass through to the browser.
 *
 * The unconfigured case is raised BEFORE the retry: a missing token will not
 * appear between two tries, and answering it three times over just delays the
 * panel switching itself off.
 */
function dashboardJson<T>(path: string, opts: CallOptions = {}): Promise<T> {
	if (!dashboardConfigured()) {
		return Promise.reject(new DashboardError(503, DISABLED_MESSAGE, DashboardErrorCode.Disabled));
	}
	const result = retrying(() => once<T>(path, opts), { attempts: (opts.retries ?? 0) + 1 });
	// Everything this app writes through the dashboard can change what the
	// gateway is able to route: a credential stored or removed, an account
	// connected or logged out, the global default model moved. The model
	// catalogue is cached for five minutes (`server/catalog.ts`), and a
	// conversation created in that window would be pinned to the old default —
	// so a successful write drops it. Over-invalidating costs one extra
	// upstream call; under-invalidating costs a wrong model on a session row.
	if ((opts.method ?? 'GET') !== 'GET') {
		return result.then((value) => {
			invalidateModelOptions();
			return value;
		});
	}
	return result;
}

async function once<T>(path: string, opts: CallOptions): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'X-Hermes-Session-Token': HERMES_DASHBOARD_TOKEN
	};
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

	let res: Response;
	try {
		res = await fetch(`${HERMES_DASHBOARD_URL}${path}`, {
			method: opts.method || 'GET',
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
		});
	} catch (err) {
		if ((err as Error)?.name === 'TimeoutError') {
			throw new DashboardError(
				504,
				`Le dashboard Hermes n'a pas répondu en ${timeoutMs} ms.`,
				DashboardErrorCode.Timeout
			);
		}
		throw new DashboardError(
			502,
			"Le dashboard Hermes est injoignable (service hermes-dashboard démarré ?).",
			DashboardErrorCode.Unreachable
		);
	}

	const text = await res.text();
	const parsed = decodeJson(text) as { detail?: string | { msg?: string }[] } | null;

	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			throw new DashboardError(
				res.status,
				'Le dashboard Hermes a refusé le jeton. Vérifiez HERMES_DASHBOARD_TOKEN ' +
					'contre HERMES_DASHBOARD_SESSION_TOKEN dans ~/.hermes/dashboard.env.',
				DashboardErrorCode.Unauthorized
			);
		}
		const detail = parsed?.detail;
		throw new DashboardError(
			res.status,
			(typeof detail === 'string' ? detail : detail?.[0]?.msg) ||
				text ||
				`Le dashboard Hermes a renvoyé HTTP ${res.status}.`,
			DashboardErrorCode.Failed
		);
	}
	return parsed as T;
}

/** `proxy()` from respond.ts, with this upstream's name on the fallback. */
export const dashboardResponse = <T>(fn: () => Promise<T>): Promise<Response> =>
	proxy(fn, { status: 502, code: DashboardErrorCode.Unreachable });

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Every known env var with its metadata. Values come back redacted — the
 * dashboard never puts a secret in this payload, and neither do we.
 */
export const getEnvVars = () => dashboardJson<EnvVarMap>('/api/env', { retries: 1 });

/**
 * Store a credential.
 *
 * Upstream this is `save_provider_env_credential`, which writes `.env` and
 * reconciles the mirrors config.yaml keeps of the same key. Never retried: a
 * replayed write is a second rotation.
 */
export const setEnvVar = (key: string, value: string) =>
	dashboardJson<Record<string, unknown>>('/api/env', {
		method: 'PUT',
		body: { key, value }
	});

/** Remove a credential, along with the mirrors upstream knows about. */
export const deleteEnvVar = (key: string) =>
	dashboardJson<Record<string, unknown>>('/api/env', {
		method: 'DELETE',
		body: { key }
	});

/**
 * Network probe of a credential before it is stored.
 *
 * Only OPENROUTER / OPENAI / XAI / GEMINI have a probe upstream; anything else
 * answers `{ok: true, reachable: false}`, which means "unknown", not "bad".
 * Given a slow provider, 15 s beats the default.
 */
export const validateCredential = (key: string, value: string) =>
	dashboardJson<ValidationResult>('/api/providers/validate', {
		method: 'POST',
		body: { key, value },
		timeoutMs: 15_000
	});

// ---------------------------------------------------------------------------
// Accounts (OAuth)
// ---------------------------------------------------------------------------

export const listOauthProviders = () =>
	dashboardJson<{ providers: OauthProvider[] }>('/api/providers/oauth', { retries: 1 });

/**
 * Begin a login. `external` providers answer 400 with the CLI command to run
 * — that is a legitimate outcome the UI displays, not a bug to paper over.
 *
 * The device-code branch for `openai-codex` blocks upstream for up to 10 s
 * waiting for a user code, hence the roomier timeout.
 */
export const startOauth = (id: string) =>
	dashboardJson<OauthStartResponse>(
		`/api/providers/oauth/${encodeURIComponent(id)}/start`,
		{ method: 'POST', body: {}, timeoutMs: 25_000 }
	);

/**
 * Read a pending login's status.
 *
 * Retried once: a dropped poll must not end a flow the user is halfway
 * through, and the call has no side effect upstream.
 */
export const pollOauth = (id: string, sessionId: string) =>
	dashboardJson<OauthPollResponse>(
		`/api/providers/oauth/${encodeURIComponent(id)}/poll/${encodeURIComponent(sessionId)}`,
		{ retries: 1, timeoutMs: 10_000 }
	).then((res) => {
		// The one write that reaches us as a GET: a device-code login completes
		// inside a poll, and the provider it just connected brings routable
		// models with it.
		if (res?.status === 'approved') invalidateModelOptions();
		return res;
	});

/** PKCE only (Anthropic): hand back the code the callback page displayed. */
export const submitOauthCode = (id: string, sessionId: string, code: string) =>
	dashboardJson<{ ok?: boolean; status?: string; message?: string }>(
		`/api/providers/oauth/${encodeURIComponent(id)}/submit`,
		{ method: 'POST', body: { session_id: sessionId, code }, timeoutMs: 30_000 }
	);

/** Abandon a pending login so its background poller stops. */
export const cancelOauthSession = (sessionId: string) =>
	dashboardJson<{ ok?: boolean }>(
		`/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
		{ method: 'DELETE' }
	);

/** Log a provider out. Upstream refuses (400) for CLI-owned credentials. */
export const disconnectOauth = (id: string) =>
	dashboardJson<{ ok?: boolean; provider?: string }>(
		`/api/providers/oauth/${encodeURIComponent(id)}`,
		{ method: 'DELETE' }
	);

// ---------------------------------------------------------------------------
// Cron delivery targets
// ---------------------------------------------------------------------------

/**
 * Where a scheduled job can send its output.
 *
 * The gateway has no equivalent endpoint — `deliver` is resolved at fire time
 * from `*_HOME_CHANNEL` env vars the API server never exposes — so this one
 * read comes from the dashboard. `home_target_set` is what tells apart a
 * platform that will actually deliver from one that would resolve to nothing.
 *
 * Read-only and carries no credential, which is why it is safe to surface even
 * though the rest of the dashboard proxy guards writes.
 */
/**
 * The whole of Hermes' config.yaml, as the dashboard normalises it.
 *
 * ~90 root keys, some of them credentials mirrored out of `.env`. It is read
 * **server-side only** and never forwarded: the approvals route picks the
 * three fields it needs and nothing else reaches the browser — the same
 * discipline `groupProviderKeys()` applies to `GET /api/env` (point 13).
 */
export const getHermesConfig = () =>
	dashboardJson<Record<string, unknown>>('/api/config', { retries: 1 });

/**
 * Write a **partial** config. The dashboard deep-merges it over what is on
 * disk, so only the keys sent here are touched — but a list is replaced
 * wholesale rather than merged, which is why the caller must compose it on a
 * policy it actually read (see `planPolicyUpdate`).
 */
export const putHermesConfig = (config: Record<string, unknown>) =>
	dashboardJson<{ ok: boolean }>('/api/config', {
		method: 'PUT',
		body: { config }
	});

/**
 * The host's own vital signs: CPU, load average, memory, uptime.
 *
 * Read-only and carries nothing sensitive — upstream's own words are "no env
 * values, no paths beyond the hermes home root". It is a nicety on a
 * diagnostics panel, so it is kept on a short leash: no retry and a 5 s
 * ceiling, because the panel waits for it alongside the gateway's readiness
 * and a wedged dashboard must not hold that back.
 *
 * Note that upstream samples the CPU for 100 ms inside the handler, so this
 * call can never be cheap and must never be polled.
 */
export const getSystemStats = () =>
	dashboardJson<SystemStats>('/api/system/stats', { timeoutMs: 5000 });

/**
 * Tokens, cost, models, tools and skills over the last `days` days.
 *
 * A read of `~/.hermes/state.db` — upstream's own SQL sums over the `sessions`
 * table plus `InsightsEngine` for the tool and skill counts. Measured through
 * this host's dashboard, ten samples each: 8–16 ms for 7, 30 and 90 days, so
 * unlike `/api/system/stats` it is cheap. Still a read, so the shared one-try
 * retry applies.
 */
export const getUsageAnalytics = (days: number) =>
	dashboardJson<unknown>(`/api/analytics/usage?days=${encodeURIComponent(String(days))}`, {
		retries: 1,
		timeoutMs: 10_000
	});

export const getCronDeliveryTargets = () =>
	dashboardJson<{ targets: { id: string; name?: string; home_target_set?: boolean }[] }>(
		'/api/cron/delivery-targets',
		{ retries: 1, timeoutMs: 8000 }
	);

// ---------------------------------------------------------------------------
// Global default model
// ---------------------------------------------------------------------------

export interface ModelAssignmentResult {
	ok?: boolean;
	provider?: string;
	model?: string;
	/** Set when the model is flagged expensive and the caller must confirm. */
	confirm_required?: boolean;
	confirm_message?: string;
}

/**
 * Point `config.yaml` at another provider/model.
 *
 * This is the GLOBAL default, so it only affects conversations created after
 * it — an open one is re-pinned through `POST /api/sessions/{id}/model` on the
 * gateway (see `chat.setModel`). Without `confirm_expensive_model` the
 * dashboard may answer `confirm_required` instead of writing anything; that is
 * a normal answer to surface, not an error.
 */
export const setMainModel = (body: {
	provider: string;
	model: string;
	confirm_expensive_model?: boolean;
}) =>
	dashboardJson<ModelAssignmentResult>('/api/model/set', {
		method: 'POST',
		body: { scope: 'main', ...body },
		timeoutMs: 25_000
	});
