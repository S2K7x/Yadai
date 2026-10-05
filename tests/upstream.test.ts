import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { UpstreamError, retrying } from '../src/lib/server/upstream.ts';
import { decodeJson } from '../src/lib/json.ts';
import { ApiError, AppErrorCode, humanizeError } from '../src/lib/errors.ts';

/**
 * The gateway, the dashboard and the skills directory used to carry three
 * copies of the same three things: an error class, a read-only retry loop, and
 * the "read the body as text, parse it if you can" dance. The copies had
 * already drifted. These tests cover the one implementation, and fail if a
 * copy comes back.
 */

// ---------------------------------------------------------------------------
// UpstreamError
// ---------------------------------------------------------------------------

test('an upstream error carries what a response needs', () => {
	const err = new UpstreamError(429, 'Trop de requêtes', 'rate_limit_exceeded', 3);
	assert.ok(err instanceof Error);
	assert.equal(err.status, 429);
	assert.equal(err.message, 'Trop de requêtes');
	assert.equal(err.code, 'rate_limit_exceeded');
	assert.equal(err.retryAfter, 3);
});

test('only 5xx is worth replaying', () => {
	// The codes each client mints for itself already come with these statuses.
	assert.equal(new UpstreamError(502, 'injoignable', 'hermes_unreachable').transient, true);
	assert.equal(new UpstreamError(504, 'trop lent', 'hermes_timeout').transient, true);
	assert.equal(new UpstreamError(500, 'boum').transient, true);

	// A refusal is not a hiccup: replaying it changes nothing.
	assert.equal(new UpstreamError(400, 'corps invalide', 'invalid_body').transient, false);
	assert.equal(new UpstreamError(404, 'disparue').transient, false);
	assert.equal(new UpstreamError(409, 'modèle non routable').transient, false);
	// Being told to slow down is not a reason to knock again.
	assert.equal(new UpstreamError(429, 'ralentissez').transient, false);
});

// ---------------------------------------------------------------------------
// retrying
// ---------------------------------------------------------------------------

/** A function that fails `failures` times before answering `value`. */
function flaky(failures: number, error: unknown, value = 'ok') {
	let calls = 0;
	const fn = async () => {
		calls += 1;
		if (calls <= failures) throw error;
		return value;
	};
	return { fn, calls: () => calls };
}

test('a call that works is made exactly once', async () => {
	const { fn, calls } = flaky(0, new UpstreamError(500, 'boum'));
	assert.equal(await retrying(fn, { attempts: 3, baseDelayMs: 0 }), 'ok');
	assert.equal(calls(), 1);
});

test('a transient failure is replayed up to the attempt count', async () => {
	const { fn, calls } = flaky(2, new UpstreamError(503, 'indisponible'));
	assert.equal(await retrying(fn, { attempts: 3, baseDelayMs: 0 }), 'ok');
	assert.equal(calls(), 3);
});

test('the last failure is what the caller sees', async () => {
	const { fn, calls } = flaky(9, new UpstreamError(500, 'toujours cassé'));
	await assert.rejects(retrying(fn, { attempts: 3, baseDelayMs: 0 }), /toujours cassé/);
	assert.equal(calls(), 3);
});

test('a refusal is not replayed', async () => {
	const { fn, calls } = flaky(9, new UpstreamError(400, 'corps invalide'));
	await assert.rejects(retrying(fn, { attempts: 3, baseDelayMs: 0 }), /corps invalide/);
	assert.equal(calls(), 1);
});

test('an error that is not an upstream one is not replayed either', async () => {
	// A bug in our own code must surface, not be run three times.
	const { fn, calls } = flaky(9, new TypeError('x is not a function'));
	await assert.rejects(retrying(fn, { attempts: 3, baseDelayMs: 0 }), TypeError);
	assert.equal(calls(), 1);
});

test('without options, nothing is replayed — retrying is opt-in per call', async () => {
	const { fn, calls } = flaky(9, new UpstreamError(500, 'boum'));
	await assert.rejects(retrying(fn));
	assert.equal(calls(), 1);
	// `retries: 0` upstream becomes `attempts: 1`, and 0 must not mean "forever".
	const second = flaky(9, new UpstreamError(500, 'boum'));
	await assert.rejects(retrying(second.fn, { attempts: 0 }));
	assert.equal(second.calls(), 1);
});

test('the backoff grows but is not paid before the first try', async () => {
	const started = Date.now();
	const { fn } = flaky(2, new UpstreamError(500, 'boum'));
	await retrying(fn, { attempts: 3, baseDelayMs: 20 });
	// 20 ms then 40 ms, and nothing before the first call.
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 55, `expected at least 55 ms of backoff, got ${elapsed}`);
});

// ---------------------------------------------------------------------------
// decodeJson
// ---------------------------------------------------------------------------

test('a body that is not JSON decodes to null instead of throwing', () => {
	// The status is the useful half: an HTML error page must not blow up
	// before the caller has looked at it.
	assert.equal(decodeJson(''), null);
	assert.equal(decodeJson('<html>502 Bad Gateway</html>'), null);
	assert.equal(decodeJson('{"truncated": '), null);
	assert.equal(decodeJson('null'), null);
});

test('a JSON body decodes to its value', () => {
	assert.deepEqual(decodeJson('{"error":{"message":"nope"}}'), { error: { message: 'nope' } });
	assert.deepEqual(decodeJson('[1,2]'), [1, 2]);
	assert.equal(decodeJson('"texte"'), 'texte');
});

// ---------------------------------------------------------------------------
// One implementation, not three
// ---------------------------------------------------------------------------

const SRC = new URL('../src/lib/server/', import.meta.url);
const CLIENTS = ['hermes.ts', 'dashboard.ts', 'skills.ts'];

const read = (name: string) => readFile(new URL(name, SRC), 'utf8');

test('the three upstream clients share one error class', async () => {
	for (const name of CLIENTS) {
		const source = await read(name);
		assert.match(
			source,
			/extends UpstreamError/,
			`${name} must build its error class on UpstreamError`
		);
	}
});

test('nobody re-declares the retry loop or the body decode', async () => {
	for (const name of ['hermes.ts', 'dashboard.ts']) {
		const source = await read(name);
		assert.ok(source.includes('retrying('), `${name} must use the shared retry`);
		assert.doesNotMatch(
			source,
			/function isTransient/,
			`${name} re-declares its own idea of a transient failure`
		);
		assert.doesNotMatch(
			source,
			/JSON\.parse\(text\)/,
			`${name} re-declares the body decode instead of using decodeJson`
		);
	}
});

test('every upstream error is built as (status, message, code)', async () => {
	// The three classes disagreed on this order for a while, and a swap between
	// two strings is invisible to the compiler: it just ships a code where the
	// user should have read a sentence.
	const source = await read('skills.ts');
	assert.doesNotMatch(
		source,
		/new SkillsFsError\(\s*\d+,\s*'[a-z][a-z0-9_]*'/,
		'a SkillsFsError is being built with its code where the message goes'
	);
});

// ---------------------------------------------------------------------------
// Two 429s, two facts
// ---------------------------------------------------------------------------

/**
 * `gate()` used to borrow upstream's `rate_limit_exceeded`.
 *
 * That code is Hermes' word for its concurrent-run cap — `_handle_create_run`
 * answers `429 {"code": "rate_limit_exceeded"}` with "Too many concurrent runs
 * (max N)" (api_server.py 0.20.0) — and `humanizeError` translates it into a
 * sentence about simultaneous turns, which is the point of having a code at
 * all. Our token bucket is a different fact with a different remedy, so a
 * rate-limited `GET /api/skills/files` (measured at twelve calls in a burst)
 * was telling the user that Hermes was at its turn cap while nothing was
 * running at all.
 */
test('the token bucket does not speak in the concurrency cap\'s name', async () => {
	const respond = await readFile(new URL('respond.ts', SRC), 'utf8');
	const gate = respond.slice(respond.indexOf('export function gate('));
	assert.match(gate, /AppErrorCode\.TooManyRequests/);
	assert.doesNotMatch(
		gate,
		/AppErrorCode\.RateLimited/,
		'gate() is minting the code that means "an agent is already running"'
	);

	// And the turn semaphore keeps it: that one really is the cap.
	const stream = await readFile(
		new URL('../src/routes/api/sessions/[id]/stream/+server.ts', import.meta.url),
		'utf8'
	);
	assert.match(stream, /AppErrorCode\.RateLimited/);
});

test('each of the two 429s gets its own sentence', () => {
	const cap = humanizeError(
		new ApiError(429, 'Too many concurrent runs (max 10)', AppErrorCode.RateLimited)
	);
	const bucket = humanizeError(
		new ApiError(429, 'Trop de requêtes. Ralentissez un instant.', AppErrorCode.TooManyRequests)
	);
	assert.match(cap, /tours simultanés/);
	assert.doesNotMatch(bucket, /tours simultanés/);
	assert.notEqual(cap, bucket);
	// Both are still worth replaying — only the explanation differs.
	assert.ok(new ApiError(429, '', AppErrorCode.TooManyRequests).retryable);
});
