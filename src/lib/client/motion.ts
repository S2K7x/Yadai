import { REDUCED_MOTION_QUERY, motionMs, scrollMotion } from '$lib/motion';

/**
 * The browser side of the motion policy — same split as `trapIndex` (pure)
 * and `trapTab` (DOM) in `a11y.ts` / `client/dialog.svelte.ts`.
 */

let query: MediaQueryList | null = null;
let asked = false;

/**
 * Does this device ask for less motion?
 *
 * Read at the moment it matters rather than cached as a value: the setting can
 * be turned on mid-session (iOS Control Centre, a system-wide shortcut), and a
 * `MediaQueryList` reports the current answer without a listener to keep in
 * sync. No `window` — SSR is off, but a test harness is not a browser — means
 * "no preference expressed", which is the ordinary case.
 */
export function reducedMotion(): boolean {
	if (!asked) {
		asked = true;
		query =
			typeof window !== 'undefined' && typeof window.matchMedia === 'function'
				? window.matchMedia(REDUCED_MOTION_QUERY)
				: null;
	}
	return query?.matches ?? false;
}

/** The duration to hand a scripted animation, in ms. */
export function moveMs(ms: number): number {
	return motionMs(ms, reducedMotion());
}

/** The behaviour to hand `scrollTo` / `scrollIntoView`. */
export function scrollBehavior(): ScrollBehavior {
	return scrollMotion(reducedMotion());
}
