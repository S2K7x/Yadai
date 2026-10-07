import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { perFrame } from '../src/lib/client/frame.ts';

/**
 * `perFrame` is the one thing standing between an event stream and a forced
 * synchronous layout per event. Two surfaces lean on it — the thread scroller
 * on every `assistant.delta`, the composer's textarea on every keystroke — so
 * the coalescing itself is worth pinning down, with a hand-cranked scheduler
 * rather than a browser.
 */

/** A `requestAnimationFrame` stand-in whose frames are advanced by hand. */
function fakeFrames() {
	const queued = new Map<number, () => void>();
	let next = 1;
	return {
		schedule(cb: () => void) {
			queued.set(next, cb);
			return next++;
		},
		unschedule(handle: number) {
			queued.delete(handle);
		},
		/** Run everything scheduled so far; callbacks added here wait for the next. */
		flush() {
			const now = [...queued.entries()];
			queued.clear();
			for (const [, cb] of now) cb();
			return now.length;
		},
		get pending() {
			return queued.size;
		}
	};
}

test('a burst of requests inside one frame buys exactly one run', () => {
	const frames = fakeFrames();
	let runs = 0;
	const task = perFrame(() => runs++, frames.schedule, frames.unschedule);

	// A thousand deltas, or a hundred keystrokes, between two paints.
	for (let i = 0; i < 1000; i++) task.schedule();
	assert.equal(frames.pending, 1);
	assert.equal(runs, 0, 'nothing runs before the frame');

	frames.flush();
	assert.equal(runs, 1);
});

test('each new frame can run again', () => {
	const frames = fakeFrames();
	let runs = 0;
	const task = perFrame(() => runs++, frames.schedule, frames.unschedule);

	for (let frame = 0; frame < 5; frame++) {
		task.schedule();
		task.schedule();
		frames.flush();
	}
	assert.equal(runs, 5, 'one run per frame that asked for one');
});

test('a run that schedules again is not swallowed', () => {
	// The handle has to be cleared before the callback, or a task that asks for
	// another pass from inside itself — the scroll one does, through `tick()` —
	// would see a pending frame that is in fact the one it is running in, and
	// never come back.
	const frames = fakeFrames();
	const seen: number[] = [];
	let task: ReturnType<typeof perFrame>;
	task = perFrame(
		() => {
			seen.push(seen.length);
			if (seen.length < 3) task.schedule();
		},
		frames.schedule,
		frames.unschedule
	);

	task.schedule();
	frames.flush();
	frames.flush();
	frames.flush();
	assert.deepEqual(seen, [0, 1, 2]);
});

test('nothing runs when no frame was asked for', () => {
	const frames = fakeFrames();
	let runs = 0;
	perFrame(() => runs++, frames.schedule, frames.unschedule);
	frames.flush();
	assert.equal(runs, 0);
});

test('cancel drops a pending run and lets a later one through', () => {
	const frames = fakeFrames();
	let runs = 0;
	const task = perFrame(() => runs++, frames.schedule, frames.unschedule);

	task.schedule();
	task.cancel();
	frames.flush();
	assert.equal(runs, 0, 'a component torn down mid-frame must not touch the DOM');

	// Cancelling must not leave the task permanently wedged.
	task.schedule();
	frames.flush();
	assert.equal(runs, 1);

	// And cancelling nothing is harmless.
	task.cancel();
	task.cancel();
	assert.equal(frames.pending, 0);
});

/**
 * The composer is the site this exists for, and the guard is half of the win.
 * A `queueMicrotask(autosize)` put back, or a `requestAnimationFrame` written
 * inline next to the `scrollHeight` read, would reintroduce one forced layout
 * per keystroke without failing anything.
 */
test('the composer still measures its box through perFrame, once per text', () => {
	const composer = readFileSync(
		new URL('../src/lib/components/Composer.svelte', import.meta.url),
		'utf8'
	);
	assert.match(composer, /perFrame\(/, 'the composer should coalesce its layout read');
	assert.doesNotMatch(
		composer,
		/requestAnimationFrame|queueMicrotask/,
		'the composer should not schedule its layout read by hand'
	);
	// The same text must not be measured twice — this is what makes the second
	// pass at boot free.
	assert.match(composer, /textarea\.value === sizedFor/);
});

/**
 * The thread's autoscroll is deliberately NOT on this helper, and that is a
 * measured decision rather than an oversight — see CLAUDE.md §37. Scroll
 * events are dispatched *before* animation-frame callbacks, so a frame-deferred
 * scroll lets `onScroll` observe the freshly replaced transcript, read a large
 * gap and unpin the view first: measured on this Pi, opening a conversation
 * from the sidebar then left the thread at the top (gap 6 822 px instead of 0).
 * The microtask gets there first, which is the whole point of it.
 */
test('the thread autoscroll stays on a microtask, not on a frame', () => {
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	assert.match(
		page,
		/tick\(\)\.then\(\(\) => scroller\?\.scrollTo/,
		'the autoscroll must still run before the browser can fire a scroll event'
	);
	assert.doesNotMatch(page, /perFrame/, 'deferring the autoscroll to a frame unpins the view');
});
