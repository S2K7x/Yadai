/** Error vocabulary shared by the proxy and the browser. */

export interface ApiErrorBody {
	error: {
		message: string;
		/** Hermes' own code when it supplied one, else one of ours below. */
		code?: string;
		/** Seconds the client should wait before retrying (429 / 503). */
		retry_after?: number;
	};
}

/**
 * Codes this app mints itself, on top of whatever Hermes returns.
 *
 * A const object rather than an `enum`: `node --test` runs the sources through
 * type stripping, which cannot compile enums (they emit runtime code).
 */
export const AppErrorCode = {
	Unreachable: 'hermes_unreachable',
	Timeout: 'hermes_timeout',
	RateLimited: 'rate_limit_exceeded',
	TooLarge: 'payload_too_large',
	Forbidden: 'forbidden_origin',
	SessionGone: 'session_not_found',
	Unknown: 'unknown_error'
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

/**
 * Client-side error carrying the HTTP status and code for UI decisions.
 *
 * Fields are assigned explicitly rather than declared as constructor
 * parameter properties — type stripping (used by `node --test`) cannot compile
 * those either.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryAfter?: number;

	constructor(status: number, message: string, code?: string, retryAfter?: number) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code || AppErrorCode.Unknown;
		this.retryAfter = retryAfter;
	}

	/** Would trying again, unchanged, plausibly succeed? */
	get retryable(): boolean {
		if (this.status === 429) return true;
		if (this.status >= 500) return true;
		return this.code === AppErrorCode.Unreachable || this.code === AppErrorCode.Timeout;
	}
}

/**
 * Turn any thrown value into a sentence a person can act on.
 *
 * Raw upstream text is kept as a fallback but the known failure modes get a
 * specific explanation — "Too many concurrent runs (max 10)" tells the user
 * nothing about what to do, "un autre tour est déjà en cours" does.
 */
export function humanizeError(err: unknown): string {
	if (!(err instanceof ApiError)) {
		const message = err instanceof Error ? err.message : String(err);
		return message || 'Something unexpected went wrong.';
	}

	switch (err.code) {
		case AppErrorCode.Unreachable:
			return "Yadai is not responding. Is the gateway running? (systemctl --user status hermes-gateway)";
		case AppErrorCode.Timeout:
			return 'Yadai took too long to respond.';
		case AppErrorCode.RateLimited:
			return "Yadai is already running the maximum number of simultaneous turns. Try again in a moment.";
		case AppErrorCode.TooLarge:
			return 'Message too large. Reduce the size or number of images.';
		case AppErrorCode.SessionGone:
			return "This conversation no longer exists (deleted elsewhere?).";
		case 'session_exists':
			return 'A conversation already uses this identifier.';
		case 'invalid_title':
			return err.message; // upstream explains which title collides
		case 'session_db_unavailable':
			return "Yadai's database is unavailable (state.db).";
		case 'model_lock_persistence_failed':
			return "The requested model could not be set on this conversation.";
		case 'model_lock_unavailable':
			// Upstream refuses rather than falling back to the global default.
			return "Yadai cannot route this model. Check that its provider is configured (`hermes model`).";
		case 'missing_model':
			return 'No model selected.';
		case 'push_unavailable':
			return "Notifications are not configured on the server (VAPID keys missing).";
		case 'device_not_found':
			return "This device is no longer subscribed to notifications.";
	}

	if (err.status === 401 || err.status === 403) {
		return "Yadai refused authentication. Does HERMES_API_KEY match API_SERVER_KEY?";
	}
	return err.message || `HTTP error ${err.status}.`;
}
