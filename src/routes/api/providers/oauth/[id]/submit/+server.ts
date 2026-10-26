import type { RequestHandler } from './$types';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { dashboardResponse, submitOauthCode } from '$lib/server/dashboard';

interface SubmitBody {
	session_id?: unknown;
	code?: unknown;
}

/**
 * Hand back the authorization code for a PKCE flow — Anthropic only, upstream
 * rejects every other provider here.
 *
 * The code arrives from the provider's callback page as `<code>#<state>`; the
 * dashboard splits it itself, so it is passed through untouched.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const limited = gate('providers-oauth', 0.5, 4);
	if (limited) return limited;

	const parsed = await readJson<SubmitBody>(request);
	if ('response' in parsed) return parsed.response;

	const sessionId = parsed.body.session_id;
	const code = parsed.body.code;
	if (typeof sessionId !== 'string' || !sessionId) {
		return errorResponse(400, 'Missing OAuth session.', 'invalid_body');
	}
	if (typeof code !== 'string' || code.trim() === '') {
		return errorResponse(400, 'Paste the code the provider gave you.', 'invalid_body');
	}
	if (code.length > 4096) {
		return errorResponse(400, 'Code too long.', 'invalid_body');
	}

	return dashboardResponse(() => submitOauthCode(params.id, sessionId, code.trim()));
};
