import type { RequestHandler } from './$types';
import { errorResponse, gate, proxy } from '$lib/server/respond';
import { searchConversations } from '$lib/server/search';
import { MIN_QUERY_CHARS } from '$lib/search';

/** Longer than this is not a query any more; the rest is trimmed away. */
const MAX_QUERY_CHARS = 120;

/**
 * GET /api/search?q=… — the same passage search, across every conversation.
 *
 * Costs one upstream read per conversation probed, so it is gated far harder
 * than a listing and is never called on a keystroke: the palette runs it only
 * when the user asks for it by name.
 */
export const GET: RequestHandler = ({ url }) => {
	const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS);
	if (query.length < MIN_QUERY_CHARS) {
		return errorResponse(
			400,
			`Type at least ${MIN_QUERY_CHARS} characters to search.`,
			'invalid_query'
		);
	}

	const limited = gate('search', 1, 3);
	if (limited) return limited;

	return proxy(() => searchConversations(query));
};
