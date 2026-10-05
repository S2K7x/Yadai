import { json } from '@sveltejs/kit';
import { UpstreamError } from './upstream';
import { AppErrorCode, type ApiErrorBody } from '$lib/errors';
import { allowRequest } from './limits';

function body(message: string, code?: string, retryAfter?: number): ApiErrorBody {
	return { error: { message, code, retry_after: retryAfter } };
}

export function errorResponse(
	status: number,
	message: string,
	code?: string,
	retryAfter?: number
): Response {
	const headers: Record<string, string> = {};
	if (retryAfter) headers['Retry-After'] = String(retryAfter);
	return json(body(message, code, retryAfter), { status, headers });
}

/** What to answer when the failure is not an `UpstreamError` at all. */
export interface ProxyFallback {
	status: number;
	code: string;
}

const HERMES_FALLBACK: ProxyFallback = { status: 502, code: AppErrorCode.Unreachable };

/**
 * Run an upstream call and shape the result as a JSON response, mapping
 * `UpstreamError` onto its status and code so the browser can decide whether
 * to retry, re-sync, or just tell the user.
 *
 * The default fallback is the gateway's, since most routes proxy it; the
 * dashboard and the skills editor pass their own through `dashboardResponse()`
 * and `skillsJson()`, which are this function with one argument bound.
 */
export async function proxy<T>(
	fn: () => Promise<T>,
	fallback: ProxyFallback = HERMES_FALLBACK
): Promise<Response> {
	try {
		// `?? null` because a handler that answers nothing must still send valid
		// JSON: `undefined` would serialise to a body no client can read.
		return json((await fn()) ?? null);
	} catch (err) {
		if (err instanceof UpstreamError) {
			return errorResponse(err.status, err.message, err.code, err.retryAfter);
		}
		const message = err instanceof Error ? err.message : String(err);
		return errorResponse(fallback.status, message, fallback.code);
	}
}

/**
 * Rate-limit gate for a route class. Returns a 429 response when the caller
 * should back off, or null to proceed.
 *
 * The code is `too_many_requests`, not the `rate_limit_exceeded` this used to
 * send: that one is upstream's word for "an agent is already running" and
 * `humanizeError` explains it as such. Sharing it meant a rate-limited read of
 * the skills tree, the agent roster or the job list told the user that Hermes
 * was at its concurrent-turn cap — a sentence about a cap nothing was anywhere
 * near.
 */
export function gate(key: string, perSecond: number, burst: number): Response | null {
	if (allowRequest(key, perSecond, burst)) return null;
	return errorResponse(
		429,
		'Trop de requêtes. Ralentissez un instant.',
		AppErrorCode.TooManyRequests,
		1
	);
}

/** Parse a JSON request body, returning a 400 response instead of throwing. */
export async function readJson<T>(request: Request): Promise<{ body: T } | { response: Response }> {
	try {
		const parsed = (await request.json()) as T;
		if (!parsed || typeof parsed !== 'object') {
			return { response: errorResponse(400, 'Le corps doit être un objet JSON.', 'invalid_body') };
		}
		return { body: parsed };
	} catch {
		return { response: errorResponse(400, 'Corps JSON invalide.', 'invalid_body') };
	}
}
