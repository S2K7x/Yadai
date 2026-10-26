import type { RequestHandler } from './$types';
import { gate } from '$lib/server/respond';
import {
	DashboardError,
	dashboardConfigured,
	getEnvVars,
	listOauthProviders
} from '$lib/server/dashboard';
import { groupProviderKeys, type OauthProvider, type ProviderKeyGroup } from '$lib/providers';

interface ProvidersPayload {
	available: boolean;
	/** Why the panel is off, when it is. Shown verbatim to the user. */
	message: string;
	keys: ProviderKeyGroup[];
	accounts: OauthProvider[];
}

function json(payload: ProvidersPayload, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Everything the providers panel needs, in one round trip.
 *
 * `available: false` is a normal answer, not an error: no token, a stopped
 * `hermes-dashboard` service or a refused token all leave the rest of the app
 * working and the panel explaining itself — same contract as the skills editor
 * without its bind mount.
 *
 * `groupProviderKeys` runs HERE rather than in the browser so the 300-odd
 * unrelated rows of `GET /api/env` — including whatever custom secrets the
 * user keeps in `.env` — never reach the page, redacted or not.
 */
export const GET: RequestHandler = async () => {
	const limited = gate('providers-read', 2, 8);
	if (limited) return limited;

	if (!dashboardConfigured()) {
		return json({
			available: false,
			message:
				'HERMES_DASHBOARD_TOKEN is not configured: this app cannot ' +
				'reach the Hermes dashboard.',
			keys: [],
			accounts: []
		});
	}

	try {
		const [env, oauth] = await Promise.all([getEnvVars(), listOauthProviders()]);
		return json({
			available: true,
			message: '',
			keys: groupProviderKeys(env),
			accounts: oauth.providers ?? []
		});
	} catch (err) {
		if (err instanceof DashboardError) {
			return json({ available: false, message: err.message, keys: [], accounts: [] });
		}
		throw err;
	}
};
