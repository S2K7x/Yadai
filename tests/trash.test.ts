import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRASH_DAYS, expiredTrash, trashLabel, trashState } from '../src/lib/trash.ts';

const DAY = 86_400;
/** A fixed clock: a deadline cannot be tested against `Date.now()`. */
const NOW = 1_800_000_000;
const daysAgo = (n: number) => NOW - n * DAY;

// --- the countdown ---------------------------------------------------------

test('a conversation thrown away just now has the whole window left', () => {
	assert.deepEqual(trashState(NOW, NOW), { daysLeft: TRASH_DAYS, expired: false });
});

test('the countdown rounds down, so the app never promises a day it lacks', () => {
	// 29 days and 2 hours left must read as 29, never as 30: this number is a
	// promise about recoverability, and the safe way to be wrong is short.
	assert.equal(trashState(daysAgo(0.9), NOW).daysLeft, 29);
	assert.equal(trashState(daysAgo(29.1), NOW).daysLeft, 0);
});

test('the deadline is exclusive: the sweep may take it the moment it passes', () => {
	assert.equal(trashState(daysAgo(TRASH_DAYS), NOW).expired, true);
	assert.equal(trashState(daysAgo(TRASH_DAYS - 0.01), NOW).expired, false);
	assert.equal(trashState(daysAgo(TRASH_DAYS + 400), NOW).expired, true);
});

test('a corrupt timestamp expires rather than living forever', () => {
	// A row written by a broken version must not become undeletable.
	assert.equal(trashState(Number.NaN, NOW).expired, true);
	assert.equal(trashState(Number.POSITIVE_INFINITY, NOW).expired, true);
});

test('the label says what is left, in words a person reads', () => {
	assert.equal(trashLabel(NOW, NOW), `${TRASH_DAYS} days left`);
	assert.equal(trashLabel(daysAgo(29), NOW), '1 day left');
	assert.equal(trashLabel(daysAgo(29.5), NOW), 'last day');
	assert.equal(trashLabel(daysAgo(31), NOW), 'deleting soon');
});

// --- what the sweep is allowed to destroy ---------------------------------

test('only rows past the deadline are handed to the sweep', () => {
	const rows = [
		{ session_id: 'fresh', deleted_at: daysAgo(1) },
		{ session_id: 'due', deleted_at: daysAgo(31) },
		{ session_id: 'edge', deleted_at: daysAgo(TRASH_DAYS - 0.5) }
	];
	assert.deepEqual(expiredTrash(rows, NOW), ['due']);
});

test('the sweep is bounded, oldest first', () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({
		session_id: `s${i}`,
		deleted_at: daysAgo(40 + i)
	}));
	const picked = expiredTrash(rows, NOW, 5);
	assert.equal(picked.length, 5);
	// Oldest deadline first: the ones that have waited longest go first.
	assert.deepEqual(picked, ['s11', 's10', 's9', 's8', 's7']);
});

test('an empty bin sweeps nothing', () => {
	assert.deepEqual(expiredTrash([], NOW), []);
});

// --- the invariant the whole feature rests on -----------------------------

/**
 * The bin is only honest because the destructive endpoint is not called.
 *
 * `DELETE /api/sessions/{id}` drops the transcript, the tool calls and the
 * FTS5 rows from Hermes' state.db for good. If the ordinary delete path ever
 * reaches it again, "restore" becomes a promise the app cannot keep — and
 * nothing would fail visibly until someone tried to use it.
 */
test('the ordinary delete path never reaches the upstream delete', () => {
	const route = readFileSync(
		new URL('../src/routes/api/sessions/[id]/+server.ts', import.meta.url),
		'utf8'
	);
	const handler = route.slice(route.indexOf('export const DELETE'));
	// The only `deleteSession(` call in the handler sits behind the purge flag.
	const purgeGuard = handler.indexOf("searchParams.get('purge')");
	const upstream = handler.indexOf('deleteSession(');
	assert.ok(purgeGuard > 0, 'the handler must branch on ?purge=true');
	assert.ok(upstream > purgeGuard, 'the upstream delete may only live inside that branch');
	assert.match(handler, /trashSession\(params\.id\)/);
});

test('a live listing hides the bin, and the sweep cannot break it', () => {
	const route = readFileSync(
		new URL('../src/routes/api/sessions/+server.ts', import.meta.url),
		'utf8'
	);
	// A binned conversation is untouched upstream, so it comes back in every
	// listing and has to be filtered out here.
	assert.match(route, /const binned = trashedIds\(\);/);
	assert.match(route, /\.filter\(\(s\) => !binned\.has\(s\.id\)\)/);
	// Fire and forget: a sidebar refresh must not wait on, or fail with, a sweep.
	assert.match(route, /void sweepTrash\(\);/);
});

test('the smoke test purges its fixture instead of binning it', () => {
	const smoke = readFileSync(new URL('../scripts/smoke.sh', import.meta.url), 'utf8');
	assert.match(smoke, /DELETE "\$\{BASE\}\/api\/sessions\/\$\{sid\}\?purge=true"/);
});
