import type { RequestHandler } from './$types';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { dashboardResponse, deleteEnvVar, setEnvVar } from '$lib/server/dashboard';
import { MAX_KEY_LENGTH, isEnvKeyName } from '$lib/providers';

interface KeyBody {
	key?: unknown;
	value?: unknown;
}

/**
 * Validate the *name* only. The value is never inspected, never logged and
 * never echoed back — it goes straight through to the dashboard, which owns
 * the denylist (PATH, LD_PRELOAD, …) and answers 400 with its own reason.
 */
function keyOrError(raw: unknown): { key: string } | { response: Response } {
	if (!isEnvKeyName(raw)) {
		return {
			response: errorResponse(
				400,
				'Invalid variable name: uppercase letters, digits and underscores only.',
				'invalid_env_key'
			)
		};
	}
	return { key: raw };
}

/**
 * Store a provider credential.
 *
 * Deliberately a proxy: upstream `save_provider_env_credential` writes `.env`
 * AND reconciles the copies config.yaml holds of the same key. Writing the
 * file ourselves would leave a stale, higher-precedence value authenticating
 * with the old credential after a rotation.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const limited = gate('providers-write', 1, 5);
	if (limited) return limited;

	const parsed = await readJson<KeyBody>(request);
	if ('response' in parsed) return parsed.response;

	const named = keyOrError(parsed.body.key);
	if ('response' in named) return named.response;

	const value = parsed.body.value;
	if (typeof value !== 'string' || value.trim() === '') {
		return errorResponse(400, 'Enter a value.', 'invalid_env_value');
	}
	if (value.length > MAX_KEY_LENGTH) {
		return errorResponse(400, 'Value too long for an API key.', 'invalid_env_value');
	}

	return dashboardResponse(() => setEnvVar(named.key, value.trim()));
};

/** Remove a credential, and with it the mirrors upstream knows about. */
export const DELETE: RequestHandler = async ({ request }) => {
	const limited = gate('providers-write', 1, 5);
	if (limited) return limited;

	const parsed = await readJson<KeyBody>(request);
	if ('response' in parsed) return parsed.response;

	const named = keyOrError(parsed.body.key);
	if ('response' in named) return named.response;

	return dashboardResponse(() => deleteEnvVar(named.key));
};
