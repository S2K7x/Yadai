import { ApiError, AppErrorCode, type ApiErrorBody } from '$lib/errors';
import { decodeJson } from '$lib/json';

/**
 * Browser-side call into this app's own proxy routes.
 *
 * Every failure — network, non-JSON body, HTTP error — comes back as one
 * ApiError carrying status + code, so callers can branch on `code` instead of
 * pattern-matching English strings.
 */
export async function api<T>(
	path: string,
	init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
	const { timeoutMs = 20_000, ...rest } = init;

	// Combine the caller's signal (if any) with a timeout so a hung proxy
	// cannot leave a spinner forever.
	const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
	if (rest.signal) signals.push(rest.signal);

	let res: Response;
	try {
		res = await fetch(path, {
			...rest,
			signal: AbortSignal.any(signals),
			headers: { 'Content-Type': 'application/json', ...(rest.headers || {}) }
		});
	} catch (err) {
		if (rest.signal?.aborted) throw err; // caller cancelled: not our error
		const timeout = (err as Error)?.name === 'TimeoutError';
		throw new ApiError(
			timeout ? 504 : 0,
			timeout ? 'Timed out.' : 'Connection lost.',
			timeout ? AppErrorCode.Timeout : AppErrorCode.Unreachable
		);
	}

	const text = await res.text();
	const parsed = decodeJson(text);

	if (!res.ok) {
		const body = parsed as ApiErrorBody | null;
		throw new ApiError(
			res.status,
			body?.error?.message || text || `HTTP error ${res.status}`,
			body?.error?.code || AppErrorCode.Unknown,
			body?.error?.retry_after ?? Number(res.headers.get('Retry-After')) ?? undefined
		);
	}
	return parsed as T;
}

/**
 * Retry a read a few times with exponential backoff.
 *
 * Only for idempotent calls — never wrap a session create or an agent turn.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (!(err instanceof ApiError) || !err.retryable || i === attempts - 1) throw err;
			const wait = err.retryAfter ? err.retryAfter * 1000 : 400 * 2 ** i;
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
	throw lastError;
}
