import { getSessionMessages, listSessions } from './hermes';
import { trashedIds } from './db';
import { activityAt, sessionLabel } from '$lib/sessions';
import { TRANSCRIPT_PAGE, groupTranscript } from '$lib/transcript';
import { findInTranscript, type SearchResult, type SessionMatches } from '$lib/search';

/**
 * Searching every conversation, from the one place that can.
 *
 * The gateway has no message search: its routing table (`api_server.py`,
 * 0.20.0) exposes the listing, the row, the transcript, the fork, the chat and
 * the model lock on a session, and nothing else. The only way to answer "which
 * conversation was that in?" is therefore to read the transcripts and look —
 * which the browser cannot do for conversations it has not opened, but the
 * server can, over the loopback, in one round trip for the caller.
 *
 * It is a deliberate fan-out and it is bounded on every axis: the most
 * recently active conversations only, a few probes at a time, a handful of
 * hits per conversation. Nothing polls it — it runs when someone asks.
 */

/** Conversations probed at most, newest activity first. */
const SEARCH_SESSION_LIMIT = 40;
/** Probes in flight. Small: these land on a Pi, in SQLite. */
const SEARCH_CONCURRENCY = 4;
/** Hits kept per conversation: a palette row offers somewhere to go, not a report. */
const HITS_PER_SESSION = 3;
/**
 * Same window the browser loads for the open thread, so the ids line up.
 *
 * `order` matters as much as the size: upstream reads the page from whichever
 * end it names, so `oldest` — what this used to ask for — searched the *first*
 * 500 rows of each conversation. Past that ceiling the recent half of a long
 * conversation was unsearchable, which is the half a question like "where did
 * he give me that command?" is about.
 */
const TRANSCRIPT_ORDER = 'latest' as const;

export async function searchConversations(query: string): Promise<SearchResult> {
	const live = await listSessions({ limit: 200 });
	// Same exclusion as the sidebar: a conversation waiting in the bin is still
	// alive upstream, and finding it here would contradict having deleted it.
	const binned = trashedIds();
	const rows = (live.data ?? [])
		.filter((s) => !binned.has(s.id))
		.sort((a, b) => activityAt(b) - activityAt(a));
	const candidates = rows.slice(0, SEARCH_SESSION_LIMIT);

	const data: SessionMatches[] = [];
	for (let i = 0; i < candidates.length; i += SEARCH_CONCURRENCY) {
		const batch = await Promise.all(
			candidates.slice(i, i + SEARCH_CONCURRENCY).map(async (session) => {
				let messages;
				try {
					messages = await getSessionMessages(session.id, {
						order: TRANSCRIPT_ORDER,
						limit: TRANSCRIPT_PAGE
					});
				} catch {
					// One unreadable conversation (deleted mid-search, upstream
					// hiccup) must not empty the whole result.
					return null;
				}
				// Grouped the way the thread renders it, so a hit's id is the
				// `data-mid` the browser will scroll to once it opens the
				// conversation — searching the raw rows would hand back ids that
				// never reach the DOM.
				const hits = findInTranscript(
					groupTranscript(messages.data ?? []),
					query,
					HITS_PER_SESSION
				);
				if (!hits.length) return null;
				return {
					session_id: session.id,
					title: sessionLabel(session),
					last_active: activityAt(session),
					hits
				} satisfies SessionMatches;
			})
		);
		for (const found of batch) if (found) data.push(found);
	}

	return {
		object: 'list',
		query,
		data,
		scanned: candidates.length,
		truncated: rows.length > candidates.length
	};
}
