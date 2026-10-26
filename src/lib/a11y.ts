/**
 * Keyboard navigation helpers.
 *
 * Only the arithmetic lives here — which stop Tab should land on when it is
 * about to walk out of a dialog. Collecting the candidates and moving the
 * focus stays in `Modal.svelte`, because the tests run without a DOM.
 */

/**
 * What Tab can reach, as a selector.
 *
 * Deliberately narrower than the full HTML definition: this app has no
 * `contenteditable`, no `<audio controls>` and no `<area>`. `[tabindex="-1"]`
 * is excluded because it means "focusable by script, not by Tab" — the modal
 * card itself carries it.
 *
 * That exclusion has to be repeated on every entry rather than left to the
 * last one: `button[tabindex="-1"]` still matches `button:not([disabled])`.
 * The rows of the command palette are exactly that — options a script moves a
 * cursor through, which Tab must walk straight past.
 */
const SCRIPT_ONLY = ':not([tabindex="-1"])';
export const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'summary',
	'[tabindex]'
]
	.map((sel) => sel + SCRIPT_ONLY)
	.join(', ');

/**
 * Where focus must be *forced* so a Tab press cannot leave a modal dialog.
 *
 * `count` is how many focusable stops the dialog holds, `active` the index of
 * the one holding focus (`-1` when focus sits on the dialog itself, which is
 * where it lands when the dialog opens). Returns the index to focus, or `null`
 * when the browser's own move already stays inside and must be left alone —
 * moving focus by hand in that case would break type-ahead and text selection
 * inside a field.
 */
export function trapIndex(count: number, active: number, backwards: boolean): number | null {
	if (count <= 0) return null;
	if (active < 0 || active >= count) return backwards ? count - 1 : 0;
	if (backwards) return active === 0 ? count - 1 : null;
	return active === count - 1 ? 0 : null;
}

/**
 * Where an arrow key must put the focus inside an open popup menu.
 *
 * `count` is how many focus stops the popup holds, `active` the index of the
 * one holding focus — `-1`, or anything out of range, when focus is still on
 * the button that opened it. Returns the index to focus, or `null` when the
 * key means nothing here and must be left to the browser.
 *
 * Down and up wrap, because a popup is a closed list: walking off the end of
 * five actions should return to the first, not fall silently out of the menu.
 * From the trigger, Down enters at the top and Up at the bottom — the two ways
 * a keyboard user reaches "the last item" without counting.
 */
export function menuIndex(count: number, active: number, key: string): number | null {
	if (count <= 0) return null;
	const outside = active < 0 || active >= count;
	switch (key) {
		case 'ArrowDown':
			return outside ? 0 : (active + 1) % count;
		case 'ArrowUp':
			return outside ? count - 1 : (active - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

/** One heading of a listbox, with the options that sit under it. */
export interface OptionGroup<T> {
	head: string;
	items: Array<{ option: T; index: number }>;
}

/**
 * Fold a flat option list into the groups a listbox is allowed to contain.
 *
 * The command palette prints a heading above each kind of result — actions,
 * conversations, passages of the open thread — and keeps its rows in one flat
 * array so the arrow arithmetic stays a single modulo. Announced as a listbox
 * those headings can no longer be loose paragraphs between the rows: a
 * listbox may hold nothing but options and groups.
 *
 * So the nesting happens here, and every option carries its **flat** index
 * with it. That is the whole point of testing this: the cursor is an index
 * into the flat list, and a group that renumbered its rows would highlight one
 * row while Enter opened another — with nothing on screen to say so.
 *
 * An option with no heading joins the group above it. A first option with no
 * heading opens an unnamed group rather than being dropped, because a dropped
 * option is one the user can neither see nor reach.
 */
export function groupOptions<T extends { head?: string }>(options: T[]): Array<OptionGroup<T>> {
	const groups: Array<OptionGroup<T>> = [];
	options.forEach((option, index) => {
		if (option.head !== undefined || groups.length === 0) {
			groups.push({ head: option.head ?? '', items: [] });
		}
		groups[groups.length - 1].items.push({ option, index });
	});
	return groups;
}

/**
 * The parts of an assistant turn a screen reader needs to hear about.
 *
 * Structurally a subset of `UiMessage`, declared here rather than imported so
 * the tests stay free of the transcript module.
 */
export interface AnnounceableTurn {
	role: 'user' | 'assistant';
	content: string;
	streaming: boolean;
	steps: Array<{ tool_name: string; status: 'running' | 'done' | 'failed' }>;
	detached?: 'stopped' | 'truncated';
	error?: string;
}

/**
 * What a live region should say about the turn being played.
 *
 * Everything a sighted user reads while waiting — the blinking caret, the
 * running tool step, the "affichage interrompu" note — is painted inside a
 * plain `<div>` that no assistive technology watches. Pressing Enter therefore
 * produced *nothing* audible: no confirmation, no progress, and above all no
 * signal that the answer had landed, on turns that routinely run for minutes.
 *
 * Only the phase is spoken, never the answer itself: a polite region fed the
 * streaming text would read the reply four times over as it grows, and the
 * text is one arrow key away in the transcript anyway.
 *
 * Returns `''` when there is nothing to say — the caller renders that as an
 * empty region, which announces nothing.
 */
export function turnAnnouncement(turn: AnnounceableTurn | undefined): string {
	if (!turn || turn.role !== 'assistant') return '';
	if (turn.error) return `Error: ${turn.error}`;
	// Both detached states outlive the stream, so they come before it.
	if (turn.detached === 'truncated')
		return "The stream was cut off: the answer shown is incomplete.";
	if (turn.detached === 'stopped') return "Display detached. The agent is finishing in the background.";

	if (turn.streaming) {
		// The newest running step, because that is the one taking the time.
		for (let i = turn.steps.length - 1; i >= 0; i--) {
			const step = turn.steps[i];
			if (step.status === 'running') return `Running tool ${step.tool_name}.`;
		}
		return turn.content ? 'Answer in progress.' : 'Yadai is thinking.';
	}

	if (!turn.content) return 'Turn finished without an answer.';
	const tools = turn.steps.length;
	if (tools === 0) return 'Answer complete.';
	return `Answer complete after ${tools} tool${tools > 1 ? 's' : ''}.`;
}
