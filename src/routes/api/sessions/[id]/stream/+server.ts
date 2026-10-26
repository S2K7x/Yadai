import type { RequestHandler } from './$types';
import { sessionChatStream } from '$lib/server/hermes';
import { sseErrorResponse, sseHeaders } from '$lib/server/sse';
import { beginTurn } from '$lib/server/turns';
import { releaseTurn, tryAcquireTurn, turnLimit } from '$lib/server/limits';
import { systemPromptForSession } from '$lib/server/agents';
import { reasoningForTurn } from '$lib/server/reasoning';
import { AppErrorCode } from '$lib/errors';

/**
 * SSE relay for one agent turn.
 *
 * The browser's connection no longer governs the turn: `beginTurn` reads the
 * upstream stream to its end whatever happens and mirrors it here while the
 * client is attached (see `src/lib/server/turns.ts`). Closing this response
 * therefore detaches the display, exactly as it always did from the user's
 * point of view — but the server now learns how the turn ended and can notify.
 *
 * Errors are reported as SSE frames rather than HTTP statuses whenever the
 * stream has (or could have) started: the client reads this endpoint with a
 * stream reader, so a bare 500 body would surface as "unexpected end of
 * stream" instead of a message. `sseErrorResponse` keeps one shape for both.
 *
 * This is also the single place that decides an agent's persona. Hermes never
 * reads back the `system_prompt` stored on a session — `system_message` in the
 * request body is the only prompt a turn sees — so the conversation's agent is
 * looked up and its prompt re-composed here, on every message. The browser
 * does not get a say: a persona the client could override would drift the
 * moment two tabs disagreed, and switching a session's model even clears the
 * stored column upstream.
 *
 * The conversation's reasoning effort rides along for exactly the same reason:
 * upstream reads `model_options` off this body and keeps it request-scoped, so
 * it is composed here on every message too (see `src/lib/reasoning.ts`).
 */
export const POST: RequestHandler = async ({ params, request }) => {
	let body: { message?: unknown };
	try {
		body = await request.json();
	} catch {
		return sseErrorResponse('Invalid JSON body.', 400, 'invalid_body');
	}
	if (body.message === undefined || body.message === null || body.message === '') {
		return sseErrorResponse('Empty message.', 400, 'missing_message');
	}

	// Local cap, checked before Hermes': a Pi 5 struggles long before the
	// upstream's default of 10 concurrent runs. The slot is now held for the
	// whole turn, not only while a browser watches it.
	if (!tryAcquireTurn()) {
		return sseErrorResponse(
			`Already ${turnLimit()} turns running. Wait for one to finish.`,
			429,
			AppErrorCode.RateLimited
		);
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseTurn();
	};

	// Deliberately NOT wired to `request.signal`: a client that goes away must
	// not stop the turn, which would defeat the point of following it.
	const abort = new AbortController();

	try {
		const upstream = await sessionChatStream(
			params.id,
			{
				message: body.message,
				system_message: systemPromptForSession(params.id),
				model_options: reasoningForTurn(params.id)
			},
			abort.signal
		);
		if (!upstream.ok || !upstream.body) {
			// Hermes rejected the turn outright (404 session, 429 cap, 400 on a
			// bad content part). Read its JSON so the reason survives.
			const text = await upstream.text().catch(() => '');
			let message = `Hermes refused the turn (HTTP ${upstream.status}).`;
			let code: string | undefined;
			try {
				const parsed = JSON.parse(text);
				message = parsed?.error?.message || message;
				code = parsed?.error?.code;
			} catch {
				/* keep the generic message */
			}
			release();
			return sseErrorResponse(message, upstream.status || 502, code);
		}

		const stream = beginTurn({
			sessionId: params.id,
			upstream,
			abort,
			release,
			// Browsers always send Origin on a POST (same invariant the origin
			// check in hooks.server.ts relies on), so its absence means a
			// script — curl, the deploy smoke test — and not someone waiting.
			notifiable: Boolean(request.headers.get('origin'))
		});
		const headers = new Headers(sseHeaders());
		const sid = upstream.headers.get('X-Hermes-Session-Id');
		if (sid) headers.set('X-Hermes-Session-Id', sid);
		return new Response(stream, { status: 200, headers });
	} catch (err) {
		release();
		const message = err instanceof Error ? err.message : String(err);
		return sseErrorResponse(`Hermes unreachable: ${message}`, 502, AppErrorCode.Unreachable);
	}
};
