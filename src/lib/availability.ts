/**
 * Three answers a panel's first read can give, not two.
 *
 * Four of this app's panels stand in front of something optional: the skills
 * editor needs its bind mount, the providers panel needs a dashboard token, the
 * jobs panel needs a gateway built with its cron module. Each therefore has an
 * "it is off, and here is why" screen — and each used to reach that screen by
 * collapsing *any* failed read into it.
 *
 * That is a lie with consequences, because the wording of those screens is a
 * remedy: "add the /skills volume to docker-compose.yml and restart". Measured
 * on this Pi, `GET /api/skills/files` answers 429 `too_many_requests` past
 * twelve calls in a burst and 500 on a filesystem error (`EACCES: permission
 * denied, scandir`), and the browser mints its own failure — `Connexion
 * perdue.` — the moment a phone drops off the tailnet. All three used to print
 * the docker-compose paragraph, confidently, about a bind mount that was
 * mounted the whole time. Worse, the state stuck: the panels only re-read when
 * their availability was still unknown, so a blip disabled the editor until the
 * page was reloaded.
 *
 * So: `failed` is its own state, it outranks `disabled` (a read we could not
 * make tells us nothing about the configuration), and it is the one state that
 * re-reads when the panel is opened again.
 */

export type PanelState =
	/** No successful read yet, and nothing has failed: show a spinner. */
	| 'unread'
	/** A read succeeded and the feature is usable. */
	| 'ready'
	/** A read succeeded and said the feature is off — the only state whose
	 *  explanation may name a configuration remedy. */
	| 'disabled'
	/** The last read failed. What the configuration says is unknown. */
	| 'failed';

export interface PanelInputs {
	/** Did the last successful read say the feature is usable? */
	ready: boolean;
	/** Did the last successful read say the feature is off? */
	disabled: boolean;
	/** Message from the last read, if it failed; null once one succeeds. */
	error: string | null;
}

/**
 * Classify a panel's gate.
 *
 * `error` wins over everything, including a `disabled` learned earlier: once a
 * read has failed, the earlier answer is a memory and not an observation, and
 * showing "not configured" for something that may well be running is exactly
 * the failure this module exists to prevent.
 */
export function panelState(input: PanelInputs): PanelState {
	if (input.error) return 'failed';
	if (input.disabled) return 'disabled';
	if (input.ready) return 'ready';
	return 'unread';
}

/**
 * Should opening the panel start — or restart — its read?
 *
 * Never while one is in flight (opening and closing twice must not queue two
 * listings), never once an answer is in hand, and always after a failure: that
 * last clause is what makes a transient blip heal itself by closing the panel
 * and opening it again, instead of surviving until a page reload.
 */
export function shouldLoadPanel(state: PanelState, loading: boolean): boolean {
	if (loading) return false;
	return state === 'unread' || state === 'failed';
}
