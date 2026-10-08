import assert from 'node:assert/strict';
import test from 'node:test';
import {
	archivedCandidates,
	groupSessions,
	lineageRotations,
	matchesQuery,
	relativeTime,
	renameSession,
	rotatedSessionId,
	sessionLabel,
	usageSummary
} from '../src/lib/sessions.ts';
import { ApiError, AppErrorCode, humanizeError } from '../src/lib/errors.ts';
import type { HermesSession } from '../src/lib/types.ts';

const DAY = 86_400;
const now = () => Date.now() / 1000;

const session = (over: Partial<HermesSession> = {}): HermesSession => ({
	id: over.id ?? Math.random().toString(36).slice(2),
	last_active: now(),
	...over
});

test('groups sessions into recency bands, dropping empty ones', () => {
	const groups = groupSessions([
		session({ id: 'a', last_active: now() }),
		session({ id: 'b', last_active: now() - 2 * DAY }),
		session({ id: 'c', last_active: now() - 200 * DAY })
	]);
	assert.deepEqual(
		groups.map((g) => g.key),
		['today', 'week', 'older']
	);
});

test('pinned sessions leave their recency band', () => {
	const groups = groupSessions([
		session({ id: 'old-but-pinned', last_active: now() - 400 * DAY, pinned: true }),
		session({ id: 'fresh', last_active: now() })
	]);
	assert.equal(groups[0].key, 'pinned');
	assert.deepEqual(
		groups[0].sessions.map((s) => s.id),
		['old-but-pinned']
	);
	assert.equal(groups[1].key, 'today');
});

test('sessions sort newest-first inside a band', () => {
	const [group] = groupSessions([
		session({ id: 'older', last_active: now() - 60 }),
		session({ id: 'newer', last_active: now() })
	]);
	assert.deepEqual(
		group.sessions.map((s) => s.id),
		['newer', 'older']
	);
});

test('search ignores case and accents', () => {
	const s = session({ title: 'Résumé du déploiement' });
	assert.ok(matchesQuery(s, 'resume'));
	assert.ok(matchesQuery(s, 'DÉPLOIEMENT'));
	assert.ok(!matchesQuery(s, 'facture'));
});

test('search falls back to the preview text', () => {
	assert.ok(matchesQuery(session({ preview: 'temperature du CPU' }), 'cpu'));
});

test('label falls back through title, preview, then a placeholder', () => {
	assert.equal(sessionLabel(session({ title: 'Titre' })), 'Titre');
	assert.equal(sessionLabel(session({ title: '  ', preview: 'aperçu' })), 'aperçu');
	assert.equal(sessionLabel(session({})), 'Sans titre');
});

test('usage summary appears only once tokens exist', () => {
	assert.equal(usageSummary(session({})), null);
	assert.equal(
		usageSummary(session({ input_tokens: 21_473, output_tokens: 412, estimated_cost_usd: 0.0123 })),
		// Written by `$lib/format`, like the consumption panel — this line used to
		// have its own renderer and its own decimal separator.
		'21,5 k ↓ / 412 ↑ · 0,0123 $'
	);
});

test('known error codes get an actionable French message', () => {
	const rateLimited = new ApiError(429, 'Too many concurrent runs (max 10)', AppErrorCode.RateLimited);
	assert.match(humanizeError(rateLimited), /tours simultanés/);

	const gone = new ApiError(404, 'Session not found: x', AppErrorCode.SessionGone);
	assert.match(humanizeError(gone), /n'existe plus/);

	// 401 has no dedicated code but must still point at the real cause.
	assert.match(humanizeError(new ApiError(401, 'Unauthorized')), /HERMES_API_KEY/);
});

test('retryable classification drives the retry helper', () => {
	assert.ok(new ApiError(429, '', AppErrorCode.RateLimited).retryable);
	assert.ok(new ApiError(503, '').retryable);
	assert.ok(new ApiError(0, '', AppErrorCode.Unreachable).retryable);
	// A rejected payload will be rejected again — replaying it is pointless.
	assert.ok(!new ApiError(400, '', 'unsupported_content_type').retryable);
	assert.ok(!new ApiError(404, '', AppErrorCode.SessionGone).retryable);
});

test('archive candidates are the known ids the live listing dropped', () => {
	const known = ['e', 'd', 'c', 'b', 'a'];
	// c and a are still listed, so they are not archived.
	assert.deepEqual(archivedCandidates(known, ['c', 'a'], 10), ['e', 'd', 'b']);
	// Order follows `known`, newest-first, and the cap bounds the fan-out.
	assert.deepEqual(archivedCandidates(known, [], 2), ['e', 'd']);
	// Nothing to probe when every known session is still live.
	assert.deepEqual(archivedCandidates(known, known, 10), []);
	assert.deepEqual(archivedCandidates([], ['a'], 10), []);
	// A live id we have never recorded is simply irrelevant here.
	assert.deepEqual(archivedCandidates(['a'], ['z'], 10), ['a']);
	// A zero cap disables probing entirely rather than probing everything.
	assert.deepEqual(archivedCandidates(known, [], 0), []);
});

test('a compressed conversation reports the id it moved to', () => {
	const rows = [
		session({ id: 'plain' }),
		session({ id: 'tip-1', _lineage_root_id: 'root-1' }),
		session({ id: 'tip-2', _lineage_root_id: 'root-2' })
	];
	assert.deepEqual(lineageRotations(rows), [
		{ root: 'root-1', tip: 'tip-1' },
		{ root: 'root-2', tip: 'tip-2' }
	]);

	// An uncompressed listing has nothing to migrate.
	assert.deepEqual(lineageRotations([session({ id: 'plain' })]), []);
	// The projection only sets the field when it differs, but a row that names
	// itself as its own root is not a rotation either.
	assert.deepEqual(lineageRotations([session({ id: 'a', _lineage_root_id: 'a' })]), []);
	assert.deepEqual(lineageRotations([session({ id: 'a', _lineage_root_id: null })]), []);
	assert.deepEqual(lineageRotations([]), []);
});

test('the open conversation follows its compression continuation', () => {
	const rows = [session({ id: 'plain' }), session({ id: 'tip-1', _lineage_root_id: 'root-1' })];
	assert.equal(rotatedSessionId(rows, 'root-1'), 'tip-1');
	// Already on the continuation, or on an untouched conversation: no move.
	assert.equal(rotatedSessionId(rows, 'tip-1'), null);
	assert.equal(rotatedSessionId(rows, 'plain'), null);
	// Nothing open, or an id this listing knows nothing about.
	assert.equal(rotatedSessionId(rows, null), null);
	assert.equal(rotatedSessionId(rows, 'gone'), null);
	assert.equal(rotatedSessionId([], 'root-1'), null);
});

// ---------------------------------------------------------------------------
// Calendar-day bucketing
//
// `relativeTime` and `groupSessions` both count in *calendar days*, not in
// elapsed hours. Testing that distinction needs a fixed clock and a fixed
// zone, hence the `now` argument both take and the helper below.
// ---------------------------------------------------------------------------

/** Run `fn` with the process on `tz`, then put the ambient zone back. */
function withTz<T>(tz: string, fn: () => T): T {
	const before = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
}

/** Seconds since the epoch for a wall-clock instant in the current zone. */
const at = (localIso: string) => new Date(localIso).getTime() / 1000;

/** The band `groupSessions` filed a session under. */
const bandOf = (ts: number, now: Date) =>
	groupSessions([session({ id: 'x', last_active: ts })], now)[0]?.key;

// The Pi runs Asia/Jerusalem; Europe/Paris moves its clocks on other dates, so
// a fix that only happened to line up with one zone would show up here.
const ZONES = [
	{ zone: 'Asia/Jerusalem', springForward: '2026-03-27', fallBack: '2026-10-25' },
	{ zone: 'Europe/Paris', springForward: '2026-03-29', fallBack: '2026-10-25' }
];

for (const { zone, springForward, fallBack } of ZONES) {
	test(`${zone}: a 25-hour day does not push yesterday into "2 j"`, () => {
		withTz(zone, () => {
			// Clocks went back during `fallBack`, so that local day lasted 25h.
			// Elapsed-time arithmetic reads 24.5h here and rounds up to two days.
			const ts = at(`${fallBack}T00:30:00`);
			const now = new Date(`${fallBack}T10:00:00`);
			now.setDate(now.getDate() + 1);

			assert.equal(relativeTime(ts, now), 'hier');
			assert.equal(bandOf(ts, now), 'yesterday');
		});
	});

	test(`${zone}: a 23-hour day does not pull two days ago into "hier"`, () => {
		withTz(zone, () => {
			// Clocks went forward during `springForward`: the day before it is two
			// calendar days back, but only 23.5h of elapsed time away.
			const eve = new Date(`${springForward}T23:30:00`);
			eve.setDate(eve.getDate() - 1);
			const ts = eve.getTime() / 1000;
			const now = new Date(`${springForward}T10:00:00`);
			now.setDate(now.getDate() + 1);

			assert.equal(relativeTime(ts, now), '2 j');
			assert.equal(bandOf(ts, now), 'week');
		});
	});
}

test('a session stamped at exactly local midnight belongs to that day', () => {
	withTz('Asia/Jerusalem', () => {
		const now = new Date('2026-08-22T10:00:00');
		// Seconds-resolution timestamps land on 00:00:00 exactly often enough
		// (a job firing at midnight, for one) for the boundary to matter.
		assert.equal(bandOf(at('2026-08-22T00:00:00'), now), 'today');
		assert.equal(relativeTime(at('2026-08-22T00:00:00'), now), '00:00');
		assert.equal(bandOf(at('2026-08-21T00:00:00'), now), 'yesterday');
		assert.equal(relativeTime(at('2026-08-21T00:00:00'), now), 'hier');
	});
});

test('ten minutes across midnight is already "hier", not a few hours', () => {
	withTz('Asia/Jerusalem', () => {
		const now = new Date('2026-08-22T00:10:00');
		assert.equal(relativeTime(at('2026-08-21T23:50:00'), now), 'hier');
		// …and this morning stays today all evening.
		assert.equal(
			bandOf(at('2026-08-22T00:05:00'), new Date('2026-08-22T23:50:00')),
			'today'
		);
	});
});

test('the day count rolls over the end of a year', () => {
	withTz('Europe/Paris', () => {
		const now = new Date('2027-01-01T09:00:00');
		assert.equal(relativeTime(at('2026-12-31T23:30:00'), now), 'hier');
		assert.equal(bandOf(at('2026-12-30T12:00:00'), now), 'week');
	});
});

test('band edges: 6 days is still the week, 7 is not', () => {
	withTz('Europe/Paris', () => {
		const now = new Date('2026-08-22T10:00:00');
		assert.equal(bandOf(at('2026-08-16T10:00:00'), now), 'week'); // 6 days
		assert.equal(relativeTime(at('2026-08-16T10:00:00'), now), '6 j');
		assert.equal(bandOf(at('2026-08-15T10:00:00'), now), 'month'); // 7 days
		// Past a week the label becomes a date, never "7 j".
		assert.doesNotMatch(relativeTime(at('2026-08-15T10:00:00'), now), /\bj$/);
		assert.equal(bandOf(at('2026-07-24T10:00:00'), now), 'month'); // 29 days
		assert.equal(bandOf(at('2026-07-23T10:00:00'), now), 'older'); // 30 days
	});
});

test('a timestamp in the future reads as today, not as a negative day', () => {
	withTz('Europe/Paris', () => {
		// The Pi's clock and Hermes' can disagree by a few seconds; a session
		// dated ahead must not fall out of every band.
		const now = new Date('2026-08-22T10:00:00');
		assert.equal(bandOf(at('2026-08-23T10:00:00'), now), 'today');
		assert.equal(relativeTime(at('2026-08-22T10:00:30'), now), '10:00');
	});
});

test('a session with no timestamp shows nothing rather than 1970', () => {
	assert.equal(relativeTime(0), '');
});

// ---------------------------------------------------------------------------
// renameSession — carrying a row onto the id a compression rotated it to
// ---------------------------------------------------------------------------

const row = (id: string, extra: Partial<HermesSession> = {}): HermesSession => ({
	id,
	title: `titre ${id}`,
	...extra
});

test('a rotated conversation keeps its row, its place and its contents', () => {
	const list = [row('a'), row('b', { agent_id: 'chef', message_count: 12 }), row('c')];
	const out = renameSession(list, 'b', 'b2');
	assert.deepEqual(
		out.map((s) => s.id),
		['a', 'b2', 'c']
	);
	assert.equal(out[1].title, 'titre b');
	assert.equal(out[1].agent_id, 'chef');
	assert.equal(out[1].message_count, 12);
	// The root is remembered so the listing's own rotation lookup stays a no-op.
	assert.equal(out[1]._lineage_root_id, 'b');
});

test('renaming leaves the original array untouched', () => {
	const list = [row('a'), row('b')];
	const out = renameSession(list, 'b', 'b2');
	assert.equal(list[1].id, 'b');
	assert.notEqual(out, list);
});

test('an already-known continuation absorbs the old row instead of duplicating it', () => {
	// The listing can land between the stream ending and the store adopting it.
	const list = [row('b2'), row('b')];
	const out = renameSession(list, 'b', 'b2');
	assert.deepEqual(
		out.map((s) => s.id),
		['b2']
	);
});

test('renaming nothing is a no-op that keeps the same array', () => {
	const list = [row('a'), row('b')];
	assert.equal(renameSession(list, 'b', 'b'), list);
	assert.equal(renameSession(list, null, 'b2'), list);
	assert.equal(renameSession(list, 'b', null), list);
	assert.equal(renameSession(list, 'zzz', 'b2'), list);
});

test('a renamed row is no longer seen as rotated by the listing lookup', () => {
	const out = renameSession([row('b')], 'b', 'b2');
	assert.equal(rotatedSessionId(out, 'b2'), null);
});
