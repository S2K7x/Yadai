/**
 * Run a geometry-touching callback at most once per animation frame.
 *
 * Two places in this app read a layout property and write it back: the thread
 * scroller (`scrollHeight` → `scrollTo`, to keep a streaming answer in view)
 * and the composer's textarea (`height: auto` → `scrollHeight` → `height`, to
 * grow with the draft). Both are *forced synchronous layouts*: the read cannot
 * be answered from the last frame's boxes once something above has changed, so
 * the browser lays the whole document out on the spot.
 *
 * Both were wired to an event rather than to a frame — one per
 * `assistant.delta`, one per keystroke — so a burst of events bought a burst of
 * layouts, for a box whose size is only ever observed once per frame anyway.
 *
 * `requestAnimationFrame` rather than a timer, for three reasons:
 *
 *  - A frame is exactly the granularity at which the result can be seen. There
 *    is nothing to gain from measuring twice between two paints.
 *  - The callback runs *before* that frame's style and layout, so the write it
 *    makes still paints in the same frame as the event that scheduled it. Thus
 *    no visible lag: the textarea grows with the character that widened it.
 *  - A callback registered while the page is hidden stays pending and runs when
 *    it comes back. A backgrounded tab therefore does no layout work at all,
 *    and still lands in the right state on return — which a dropped timer or a
 *    plain `queueMicrotask` would not give.
 *
 * The schedulers are injectable so the coalescing itself can be tested without
 * a DOM; nothing else about this is worth a test.
 */
export interface FramedTask {
	/** Ask for a run on the next frame. A no-op if one is already pending. */
	schedule(): void;
	/** Drop a pending run, for component teardown. */
	cancel(): void;
}

export function perFrame(
	run: () => void,
	schedule: (cb: () => void) => number = requestAnimationFrame,
	unschedule: (handle: number) => void = cancelAnimationFrame
): FramedTask {
	let handle: number | null = null;
	// Cleared *before* `run`, so a callback that schedules again — or one that
	// awaits — gets the next frame rather than being swallowed.
	const fire = () => {
		handle = null;
		run();
	};
	return {
		schedule() {
			if (handle === null) handle = schedule(fire);
		},
		cancel() {
			if (handle !== null) {
				unschedule(handle);
				handle = null;
			}
		}
	};
}
