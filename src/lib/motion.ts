/**
 * One motion policy, for the two halves that cannot share a mechanism.
 *
 * `prefers-reduced-motion` is a system setting — iOS calls it "Reduce Motion",
 * and it is the switch someone with vestibular trouble flips once and expects
 * every app to obey. Half of this app's motion is CSS and answers the media
 * query where it is written; the other half is script (a smooth scroll, a
 * toast's fly) and cannot be reached by a stylesheet at all. These are what
 * the script half asks, so there is one definition of the policy rather than
 * a `matchMedia` call copied into each call site.
 *
 * `src/lib/client/motion.ts` is the browser side: it reads the query and
 * passes `reduced` in.
 */

/** The query both halves agree on. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * How long a scripted animation may take.
 *
 * Zero rather than a token duration: a Svelte transition given 0 ms puts the
 * element straight into its end state, which is the state the app meant all
 * along — the travel was the decoration.
 */
export function motionMs(ms: number, reduced: boolean): number {
	if (reduced || !Number.isFinite(ms) || ms <= 0) return 0;
	return Math.round(ms);
}

/**
 * How a scripted scroll travels.
 *
 * `'smooth'` is the one piece of motion here that moves the *whole* thread
 * under the reader: jumping to a passage the palette found can slide a few
 * screens' worth of text past them. Reduced motion lands on it instead, which
 * is also what `scroll-behavior: auto` means in CSS.
 */
export function scrollMotion(reduced: boolean): ScrollBehavior {
	return reduced ? 'auto' : 'smooth';
}
