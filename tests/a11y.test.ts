import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import {
	FOCUSABLE_SELECTOR,
	groupOptions,
	menuIndex,
	trapIndex,
	turnAnnouncement,
	type AnnounceableTurn
} from '../src/lib/a11y.ts';

/**
 * The focus trap of `Modal.svelte`, without a DOM.
 *
 * `trapIndex` answers one question: does this Tab press leave the dialog, and
 * if so where must focus be put back? Everything else — collecting the stops,
 * calling `.focus()` — is three lines in the component.
 */

test('Tab inside the dialog is left to the browser', () => {
	// Three stops, focus on the middle one: neither direction escapes.
	assert.equal(trapIndex(3, 1, false), null);
	assert.equal(trapIndex(3, 1, true), null);
});

test('Tab past the last stop wraps to the first, and back', () => {
	assert.equal(trapIndex(3, 2, false), 0);
	assert.equal(trapIndex(3, 0, true), 2);
});

test('Tab from the dialog itself enters at the right end', () => {
	// -1 is where focus sits when the dialog has just opened: the card.
	assert.equal(trapIndex(3, -1, false), 0);
	assert.equal(trapIndex(3, -1, true), 2);
	// Same for focus that somehow sits outside the collected stops.
	assert.equal(trapIndex(3, 9, false), 0);
});

test('a single stop keeps focus on itself', () => {
	// The ✕ button alone: Tab must not walk out to the page behind.
	assert.equal(trapIndex(1, 0, false), 0);
	assert.equal(trapIndex(1, 0, true), 0);
});

test('a dialog with nothing focusable asks for no move', () => {
	// The component then focuses the card, which cannot be expressed as an index.
	assert.equal(trapIndex(0, -1, false), null);
	assert.equal(trapIndex(0, -1, true), null);
});

test('the focusable selector skips disabled controls and script-only stops', () => {
	assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
	assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
	// The modal card itself carries tabindex="-1" and must never be a Tab stop.
	assert.ok(!/\[tabindex\](?!:not)/.test(FOCUSABLE_SELECTOR));
});

test('every entry of the selector excludes script-only stops, not just the last', () => {
	// `button[tabindex="-1"]` matches `button:not([disabled])` all the same, so
	// the exclusion has to be repeated: the palette's rows are buttons a script
	// moves a cursor through, and counting them as Tab stops would put thirty
	// of them between the search field and the way out.
	for (const part of FOCUSABLE_SELECTOR.split(', ')) {
		assert.ok(part.endsWith(':not([tabindex="-1"])'), `${part} would catch a script-only stop`);
	}
});

/**
 * A listbox may hold nothing but options and groups, so the palette's headings
 * stopped being loose paragraphs between its rows. The arrow arithmetic still
 * runs on one flat array: what matters here is that the flat index survives
 * the nesting, because a cursor and a click that disagree look like nothing at
 * all on screen.
 */
test('grouping options keeps their flat index', () => {
	const rows = [
		{ head: 'Actions', label: 'a' },
		{ label: 'b' },
		{ head: 'Conversations', label: 'c' },
		{ label: 'd' },
		{ label: 'e' }
	];
	const groups = groupOptions(rows);
	assert.deepEqual(
		groups.map((g) => g.head),
		['Actions', 'Conversations']
	);
	assert.deepEqual(
		groups.flatMap((g) => g.items.map((it) => it.index)),
		[0, 1, 2, 3, 4]
	);
	assert.equal(groups[1].items[0].option.label, 'c');
});

test('grouping options drops none of them', () => {
	// A first row with no heading cannot be thrown away: an option the user can
	// neither see nor reach is worse than an unnamed group.
	const groups = groupOptions([{ label: 'orphan' }, { head: 'Suite', label: 'x' }]);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].head, '');
	assert.deepEqual(
		groups.flatMap((g) => g.items.map((it) => it.index)),
		[0, 1]
	);
	assert.deepEqual(groupOptions([]), []);
});

/**
 * The command palette is the app's keyboard surface, and it navigated blind.
 *
 * Its result list scrolls past 70vh with a dozen conversations and the
 * matching passages of a long thread, but the highlight never followed it:
 * Down a dozen times moved a marker off screen, and Enter opened something
 * that had never been visible. Nothing else reported it — the panel looked
 * perfectly still. And with focus staying in the search field, a screen reader
 * was told nothing at all about which row that marker was on.
 */
const PALETTE = readFileSync(
	new URL('../src/lib/components/CommandPalette.svelte', import.meta.url),
	'utf8'
);

test('the palette cursor is scrolled back into view', () => {
	assert.match(PALETTE, /scrollIntoView\(\{ block: 'nearest' \}\)/);
});

test('the palette announces its list, and which row the cursor is on', () => {
	assert.match(PALETTE, /role="combobox"/);
	assert.match(PALETTE, /aria-activedescendant=\{rows\[index\] \? `\$\{OPTION_ID\}\$\{index\}` : undefined\}/);
	assert.match(PALETTE, /role="listbox"/);
	assert.match(PALETTE, /role="option"/);
	assert.match(PALETTE, /aria-selected=\{i === index\}/);
	// Ids have to line up on both ends, or the pointer names nothing.
	assert.match(PALETTE, /id="\{OPTION_ID\}\{i\}"/);
	assert.match(PALETTE, /aria-controls="palette-results"/);
	assert.match(PALETTE, /id="palette-results"/);
});

test('the palette rows are options, not Tab stops, and Tab stays inside', () => {
	// Thirty results would otherwise be thirty Tab stops in front of the way
	// out — and a dialog calling itself modal would be letting Tab walk into
	// the page behind the scrim.
	assert.match(PALETTE, /role="option"\s+aria-selected=\{i === index\}\s+tabindex="-1"/);
	assert.match(PALETTE, /import \{ trapTab \} from '\$lib\/client\/dialog\.svelte'/);
	assert.match(PALETTE, /onkeydown=\{\(event\) => card && trapTab\(card, event\)\}/);
});

test('the palette reuses the arrow arithmetic, and leaves Home and End alone', () => {
	assert.match(PALETTE, /menuIndex\(rows\.length, index, event\.key\)/);
	// Home and End belong to the text field of an editable combobox.
	assert.match(PALETTE, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
	assert.doesNotMatch(PALETTE, /event\.key === 'Home'/);
});

test('the palette rows are thumb-sized on a phone', () => {
	const narrow = PALETTE.slice(PALETTE.indexOf('@media (max-width: 820px)'));
	assert.match(narrow, /\.rows button \{[^}]*min-height:\s*44px/);
});

/**
 * A control whose focus ring was removed and never replaced is invisible to
 * anyone navigating with a keyboard. `:focus-visible` in `app.css` puts one
 * back on everything — but only where a component has not overridden it with a
 * more specific `outline: none`. Svelte scoping makes those overrides win, so
 * they are counted here: the two big text-editing surfaces keep the caret as
 * their indicator, and nothing else may join them without saying so.
 */
test('no control drops its focus ring behind the global one', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	const allowed = new Map([
		// The composer box lights up instead (`.composer:focus-within`).
		['Composer.svelte', 1],
		// The skills editor fills its pane; the caret is the indicator there.
		['SkillsPanel.svelte', 1],
		// The dialog card takes focus on open so it is announced, not ringed.
		['Modal.svelte', 1],
		// Same call for the mobile drawer, which is that same dialog.
		['Sidebar.svelte', 1]
	]);
	const files = readdirSync(dir).filter((f) => f.endsWith('.svelte'));
	assert.ok(files.length > 10, 'the components should be there');
	for (const name of files) {
		const source = readFileSync(new URL(name, dir), 'utf8');
		const count = source.match(/outline:\s*none/g)?.length ?? 0;
		assert.equal(count, allowed.get(name) ?? 0, `${name} removes a focus ring`);
	}

	const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
});

/**
 * The mobile drawer is a dialog, and a closed drawer is not merely off screen.
 *
 * Under 820px the sidebar leaves the layout and slides over the thread behind
 * a scrim. Parked at `translateX(-100%)` it stayed fully reachable: Tab walked
 * through some twenty invisible controls before reaching the composer, and
 * VoiceOver read out a conversation list nobody could see. These tests pin the
 * three attributes that fix it, because none of them shows up in a screenshot.
 */
const SIDEBAR = readFileSync(
	new URL('../src/lib/components/Sidebar.svelte', import.meta.url),
	'utf8'
);

test('a closed drawer is inert, not just translated out of view', () => {
	assert.match(SIDEBAR, /inert=\{drawer && !open\}/);
});

test('an open drawer announces itself as a modal dialog', () => {
	// Only as a drawer: on a wide screen it is a plain column of the layout,
	// and a permanently visible `role="dialog"` would be a lie.
	assert.match(SIDEBAR, /role=\{modal \? 'dialog' : undefined\}/);
	assert.match(SIDEBAR, /aria-modal=\{modal \? 'true' : undefined\}/);
	assert.match(SIDEBAR, /aria-label=\{modal \? 'Chats' : undefined\}/);
	assert.match(SIDEBAR, /let modal = \$derived\(drawer && open\)/);
});

test('the drawer reuses the dialog focus contract instead of copying it', () => {
	assert.match(SIDEBAR, /import \{ dialogFocus, trapTab \} from '\$lib\/client\/dialog\.svelte'/);
	const modal = readFileSync(new URL('../src/lib/components/Modal.svelte', import.meta.url), 'utf8');
	assert.match(modal, /import \{ dialogFocus, trapTab \} from '\$lib\/client\/dialog\.svelte'/);
	// The trap arithmetic and the focusable selector stay in one place too.
	const dialog = readFileSync(new URL('../src/lib/client/dialog.svelte.ts', import.meta.url), 'utf8');
	assert.match(dialog, /from '\$lib\/a11y'/);
});

/**
 * `Escape` closes the drawer, because Tab cannot leave it.
 *
 * A trap without a documented way out is a cage; every other modal surface in
 * the app already answers Escape.
 */
test('Escape closes the drawer before it stops a running turn', () => {
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	const escape = page.slice(page.indexOf("if (event.key === 'Escape')"));
	const drawer = escape.indexOf('sidebarOpen = false');
	const stop = escape.indexOf('chat.stop()');
	assert.ok(drawer > 0 && stop > 0, 'both branches must exist');
	assert.ok(drawer < stop, 'closing the drawer comes first');
});

/**
 * The row menu — rename, pin, branch, archive, delete — used to appear on
 * hover only. A finger has no hover, so on a phone those five actions were
 * unreachable on every row but the selected one; a Tab stop with `opacity: 0`
 * was just as invisible to a keyboard.
 */
test('the row actions are not hidden behind hover alone', () => {
	assert.match(SIDEBAR, /@media \(hover: hover\) and \(min-width: 821px\)/);
	assert.match(SIDEBAR, /\.row:focus-within \.more/);
	// `opacity: 0` on `.more` may only be declared inside that guarded block.
	const guarded = SIDEBAR.slice(SIDEBAR.indexOf('@media (hover: hover)'));
	const all = SIDEBAR.match(/\.more \{[^}]*opacity:\s*0/g) ?? [];
	const inside = guarded.match(/\.more \{[^}]*opacity:\s*0/g) ?? [];
	assert.equal(all.length, inside.length, '.more may only be hidden where a pointer can reveal it');
	assert.equal(inside.length, 1);
});

/**
 * One trap at a time.
 *
 * On a phone a settings panel opened from the drawer would sit on a dialog
 * that is itself trapping Tab, and two traps pulling in opposite directions is
 * worse than none — the drawer would drag the focus out of the panel the user
 * is actually in. So the drawer only answers a Tab pressed inside itself, and
 * opening a panel from it closes it.
 */
test('the drawer never traps a Tab pressed outside itself', () => {
	assert.match(SIDEBAR, /panel\.contains\(event\.target as Node\)/);
});

test('a settings panel opened from the sidebar closes it', () => {
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	// The sidebar has two doors now: the settings hub, and the status line.
	// Everything else is reached from inside the hub.
	for (const prop of ['onopenSettings', 'onopenStatus']) {
		assert.match(
			page,
			new RegExp(`${prop}=\\{\\(\\) => openFromSidebar\\(`),
			`${prop} must go through openFromSidebar`
		);
	}
	assert.match(page, /function openFromSidebar\([\s\S]{0,120}sidebarOpen = false/);
});

/**
 * The hub is a doorway, not a destination.
 *
 * It opens seven other dialogs, and a dialog opened on top of one that is
 * still trapping Tab is the same two-traps-pulling-apart problem the drawer
 * had: the focus would be dragged out of the panel the user is actually in.
 * So the hub closes itself first.
 */
test('the settings hub closes before opening what it points at', () => {
	const hub = readFileSync(
		new URL('../src/lib/components/SettingsPanel.svelte', import.meta.url),
		'utf8'
	);
	assert.match(hub, /function go\(run: \(\) => void\) \{\s*onclose\(\);\s*run\(\);/);
	// Every entry goes through it, so none can forget.
	assert.doesNotMatch(hub, /onclick=\{entry\.run\}/);
	assert.match(hub, /onclick=\{\(\) => go\(entry\.run\)\}/);
});


/**
 * The three popup menus — the model picker, the agent picker and the ⋯ of a
 * sidebar row — were pointer-only surfaces. `menuIndex` is the arrow-key half;
 * the rest of the contract is asserted against the sources below.
 */

test('Down and Up enter an open popup from its trigger', () => {
	// -1 is where focus sits when the popup has just been opened: on the button.
	assert.equal(menuIndex(5, -1, 'ArrowDown'), 0);
	assert.equal(menuIndex(5, -1, 'ArrowUp'), 4);
});

test('a popup list wraps at both ends instead of dropping out', () => {
	assert.equal(menuIndex(5, 4, 'ArrowDown'), 0);
	assert.equal(menuIndex(5, 0, 'ArrowUp'), 4);
	assert.equal(menuIndex(5, 1, 'ArrowDown'), 2);
	assert.equal(menuIndex(5, 1, 'ArrowUp'), 0);
});

test('Home and End reach the ends of a long list', () => {
	// The model picker shows up to 60 entries; counting them is not a plan.
	assert.equal(menuIndex(60, 31, 'Home'), 0);
	assert.equal(menuIndex(60, 31, 'End'), 59);
});

test('any other key is left to the browser', () => {
	for (const key of ['Tab', 'Enter', ' ', 'a', 'ArrowLeft', 'Escape']) {
		assert.equal(menuIndex(5, 1, key), null, key);
	}
});

test('an empty popup asks for no move', () => {
	// The model picker with no authenticated provider shows a hint and nothing else.
	assert.equal(menuIndex(0, -1, 'ArrowDown'), null);
	assert.equal(menuIndex(0, -1, 'End'), null);
});

test('a stale index is treated as focus sitting outside the list', () => {
	// The list can shrink under the focus: the picker filters as you type.
	assert.equal(menuIndex(3, 7, 'ArrowDown'), 0);
	assert.equal(menuIndex(3, 7, 'ArrowUp'), 2);
});

/**
 * Escape must die inside the popup.
 *
 * `+page.svelte` reads a bare Escape as a much larger intent — close the mobile
 * drawer, or, while a turn is streaming, detach the answer being written. A
 * dropdown left over the header used to hand it exactly that: dismissing the
 * model list stopped watching the reply. The stop lives in the shared helper so
 * that no popup can forget it.
 */
test('the shared popup helper swallows Escape', () => {
	const menu = readFileSync(new URL('../src/lib/client/menu.svelte.ts', import.meta.url), 'utf8');
	const escape = menu.slice(menu.indexOf("if (event.key === 'Escape')"));
	assert.match(escape.slice(0, 200), /event\.stopPropagation\(\)/);
	assert.match(menu, /from '\$lib\/a11y'/);
});

test('every popup routes its keys through that helper and gives the focus back', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	for (const name of [
		'ModelPicker.svelte',
		'AgentPicker.svelte',
		'Sidebar.svelte',
		'Composer.svelte'
	]) {
		const source = readFileSync(new URL(name, dir), 'utf8');
		assert.match(source, /import \{ menuKeydown \} from '\$lib\/client\/menu\.svelte'/, name);
		assert.match(source, /menuKeydown\([\s\S]{0,40}\) === 'close'/, name);
		// The trigger announces the popup, and takes the focus back on Escape.
		assert.match(source, /aria-haspopup="true"/, name);
		assert.match(source, /aria-expanded=/, name);
		assert.match(source, /refocus[\s\S]{0,80}\.focus\(\)/, name);
	}
});

/**
 * A popup row is a tap target like any other. 6px of padding around 13px of
 * text is 30px tall — and in the sidebar menu "Supprimer" sits right under
 * "Archiver".
 */
test('popup rows are thumb-sized on a phone', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	for (const name of [
		'ModelPicker.svelte',
		'AgentPicker.svelte',
		'Sidebar.svelte',
		'Composer.svelte'
	]) {
		const source = readFileSync(new URL(name, dir), 'utf8');
		const narrow = source.slice(source.indexOf('@media (max-width: 820px)'));
		assert.ok(narrow.length > 0, `${name} has no phone block`);
		assert.match(narrow, /\.(items|menu|palette) button[\s\S]{0,120}min-height: 44px/, name);
	}
});

/**
 * The composer holds the two popups the sweep above missed.
 *
 * `+page.svelte` reads a bare Escape as "close the drawer" or, while a turn is
 * streaming, "detach the answer". **Measured at 414x896** against the built
 * app, before this: an Escape pressed inside the saved-prompts library left it
 * open *and* reached the window handler, and the "/" palette closed but let the
 * key through all the same. The tap targets were the smallest in the app — the
 * library's close button 22x14, its "supprimer" 28x24 pressed against a 332px
 * row that inserts the prompt, so a mis-tap threw a saved prompt away.
 *
 * And the "/" palette navigated blind, exactly as the command palette once
 * did: eight matches are 350px of rows in a 260px box, and walking the cursor
 * to the last one left it 301px down a list 260px tall with `scrollTop` still
 * at 0. Enter then ran a skill that had never been on screen.
 */
const COMPOSER = readFileSync(
	new URL('../src/lib/components/Composer.svelte', import.meta.url),
	'utf8'
);

test('the skills palette stops Escape instead of detaching the turn', () => {
	// Two popups live in this file, so the assertion has to name the branch:
	// the one guarded by `paletteOpen`, not the prompt library above it.
	const branch = COMPOSER.slice(COMPOSER.indexOf('if (paletteOpen && paletteMatches.length)'));
	const escape = branch.slice(branch.indexOf("event.key === 'Escape'"));
	assert.match(escape.slice(0, 400), /event\.stopPropagation\(\)/);
	assert.match(escape.slice(0, 400), /paletteOpen = false/);
});

test('the skills palette announces its rows, and which one the cursor is on', () => {
	assert.match(COMPOSER, /role="listbox"/);
	assert.match(COMPOSER, /aria-label="Skills"/);
	// Options, not Tab stops: the arrows already reach them from the field.
	assert.match(COMPOSER, /role="option"\s+aria-selected=\{i === paletteIndex\}\s+tabindex="-1"/);
	// The pointer and the ids it names have to line up on both ends.
	assert.match(COMPOSER, /id="\{SKILL_OPTION_ID\}\{i\}"/);
	assert.match(COMPOSER, /aria-activedescendant=\{paletteOpen && paletteMatches\[paletteIndex\]/);
	assert.match(COMPOSER, /aria-controls=\{paletteOpen && paletteMatches\.length \? 'composer-skills'/);
	assert.match(COMPOSER, /id="composer-skills"/);
});

test('the highlighted skill is scrolled back into view', () => {
	assert.match(COMPOSER, /scrollIntoView\(\{\s*block: 'nearest'/);
});

test('the prompt library gives the focus back to its own trigger', () => {
	// Not to whatever had it: the caret may be mid-sentence in the field, which
	// is why the field's own Escape closes without refocusing.
	assert.match(COMPOSER, /function closePrompts\(refocus = false\)/);
	assert.match(COMPOSER, /if \(refocus\) promptTrigger\?\.focus\(\)/);
	assert.match(COMPOSER, /closePrompts\(true\)/);
});

/**
 * The turn's live region.
 *
 * The whole waiting experience — caret, tool steps, "affichage interrompu" —
 * is painted in a plain div that no screen reader watches, so pressing Enter
 * used to produce nothing audible at all, on turns that run for minutes.
 * `turnAnnouncement` is the sentence a polite region says instead.
 */
const turn = (over: Partial<AnnounceableTurn> = {}): AnnounceableTurn => ({
	role: 'assistant',
	content: '',
	streaming: false,
	steps: [],
	...over
});

test('nothing is announced when there is no assistant turn to talk about', () => {
	assert.equal(turnAnnouncement(undefined), '');
	// The user's own bubble is the last message only until the empty
	// assistant is pushed next to it; either way it is not spoken.
	assert.equal(turnAnnouncement(turn({ role: 'user', content: 'salut' })), '');
});

test('a running turn says which phase it is in', () => {
	assert.equal(turnAnnouncement(turn({ streaming: true })), 'Yadai is thinking.');
	assert.equal(turnAnnouncement(turn({ streaming: true, content: 'Voici' })), 'Answer in progress.');
});

test('the newest running tool is the one named', () => {
	const steps: AnnounceableTurn['steps'] = [
		{ tool_name: 'terminal', status: 'done' },
		{ tool_name: 'web_search', status: 'running' }
	];
	assert.equal(turnAnnouncement(turn({ streaming: true, steps })), 'Running tool web_search.');
	// Once it completes, the phase falls back to the text being written.
	steps[1].status = 'done';
	assert.equal(
		turnAnnouncement(turn({ streaming: true, steps, content: 'a' })),
		'Answer in progress.'
	);
});

test('the end of a turn is announced, with the work it took', () => {
	assert.equal(turnAnnouncement(turn({ content: 'fini' })), 'Answer complete.');
	assert.equal(
		turnAnnouncement(turn({ content: 'fini', steps: [{ tool_name: 'terminal', status: 'done' }] })),
		'Answer complete after 1 tool.'
	);
	assert.equal(
		turnAnnouncement(
			turn({
				content: 'fini',
				steps: [
					{ tool_name: 'terminal', status: 'done' },
					{ tool_name: 'read_file', status: 'done' }
				]
			})
		),
		'Answer complete after 2 tools.'
	);
	assert.equal(turnAnnouncement(turn({})), 'Turn finished without an answer.');
});

test('a turn that failed or was let go says so instead of "complete"', () => {
	assert.equal(
		turnAnnouncement(turn({ error: 'Hermes is unreachable.' })),
		'Error: Hermes is unreachable.'
	);
	assert.match(turnAnnouncement(turn({ detached: 'stopped' })), /^Display detached\./);
	assert.match(turnAnnouncement(turn({ detached: 'truncated' })), /incomplete\.$/);
	// Detaching leaves `streaming` false, but a truncation is noticed while the
	// flag may still be up: the reason must win over the phase either way.
	assert.match(turnAnnouncement(turn({ streaming: true, detached: 'truncated' })), /incomplete\.$/);
});

/**
 * The region only exists if the page renders it, and it must stay silent about
 * a transcript loaded from history — announcing "Answer complete." about a
 * conversation the user has just *opened* would be a lie about their own action.
 */
test('the page owns a polite live region gated on a turn it watched stream', () => {
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	assert.match(page, /import \{ turnAnnouncement \} from '\$lib\/a11y'/);
	assert.match(page, /aria-live="polite"/);
	assert.match(page, /class="sr-only"[^>]*role="status"/);
	assert.match(page, /liveTurnId/);
	assert.match(page, /last\.id === liveTurnId/);
});

/**
 * Two glyphs and a transcript of unattributed paragraphs. A screen reader read
 * the send button as "↑" and gave no clue whether a message came from the user
 * or from Hermes.
 */
test('the conversation says who is speaking, and the composer names its controls', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	const message = readFileSync(new URL('Message.svelte', dir), 'utf8');
	assert.match(message, /<span class="sr-only">You:<\/span>/);
	assert.match(message, /<span class="sr-only">Yadai:<\/span>/);

	const composer = readFileSync(new URL('Composer.svelte', dir), 'utf8');
	assert.match(composer, /aria-label="Send message"/);
	assert.match(composer, /aria-label="Stop display"/);
	// The textarea's name must not flip to "Hermes travaille…" mid-turn.
	assert.match(composer, /aria-label="Message to Yadai"/);
});

/**
 * The phone header, measured rather than assumed.
 *
 * At 390px the header carries a burger, the conversation's title and four
 * controls. Measured in Chromium at that width: the title element was **zero
 * pixels wide** — the token counter beside it and controls that would not
 * shrink had taken every pixel, and `min-width: 0` let the title collapse
 * silently instead of overflowing where it would have been noticed. The name
 * of what you are reading is not the thing that gives way.
 */
test('the phone header keeps the conversation title', () => {
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	// The counter is a desktop nicety; the same figures are in the status panel.
	assert.match(page, /\{#if usage && !narrow\}/);
	const phone = page.slice(page.indexOf('@media (max-width: 820px)'));
	// Two rows on a phone: burger, title and search first, the two pickers on
	// a row of their own — measured at 390px, one row left the title five
	// letters and pushed the model chip off the right edge.
	assert.match(phone, /header \{[^}]*flex-wrap:\s*wrap/);
	assert.match(phone, /\.head-actions \{[^}]*display:\s*contents/);
	assert.match(phone, /\.pickers \{[^}]*flex:\s*1 0 100%/);
	assert.match(phone, /\.heading \{[^}]*min-width:\s*0/);
	// Five controls beside the title left it three characters wide. Appearance
	// steps aside because it is also in the drawer's footer and in the palette;
	// the conversation's name has nowhere else to be shown.
	assert.match(phone, /\.icon\.theme \{[^}]*display:\s*none/);
	assert.match(page, /class="icon theme"[\s\S]{0,120}aria-label="Appearance"/);
	assert.match(page, /id: 'appearance'/);
});

/**
 * An empty composer must be one row tall on a phone.
 *
 * The placeholder's parenthetical hint wrapped at 390px, which made the bar
 * two rows tall before a single character was typed. A placeholder cannot be
 * changed from CSS, so the width the page already tracks for the drawer is
 * passed down instead of being measured a second time.
 */
test('the composer shortens its placeholder where the bar is narrow', () => {
	const composer = readFileSync(
		new URL('../src/lib/components/Composer.svelte', import.meta.url),
		'utf8'
	);
	assert.match(composer, /let \{ narrow = false \}: Props = \$props\(\)/);
	assert.match(composer, /narrow\s*\?\s*'Message Yadai…'/);
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	assert.match(page, /<Composer bind:this=\{composer\} \{narrow\} \/>/);
});

/**
 * 44px is what this app promises a thumb everywhere else (point 20). The
 * round controls of the composer were measured at 36px, and the two header
 * pickers at 34px.
 */
test('every round control is thumb-sized on a phone', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	const composer = readFileSync(new URL('Composer.svelte', dir), 'utf8');
	const phone = composer.slice(composer.indexOf('@media (max-width: 820px)'));
	assert.match(phone, /\.attach,\s*\n\s*\.send \{[^}]*width:\s*44px/);
	assert.match(phone, /\.attach,\s*\n\s*\.send \{[^}]*height:\s*44px/);

	for (const name of ['ModelPicker.svelte', 'AgentPicker.svelte']) {
		const source = readFileSync(new URL(name, dir), 'utf8');
		const block = source.slice(source.indexOf('@media (max-width: 820px)'));
		assert.match(block, /\.trigger \{[^}]*min-height:\s*44px/, name);
	}

	const message = readFileSync(new URL('Message.svelte', dir), 'utf8');
	const acts = message.slice(message.indexOf('@media (max-width: 820px)'));
	assert.match(acts, /\.actions button \{[^}]*min-height:\s*44px/);

	// The welcome screen's agent chips, measured at 38px.
	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	const pagePhone = page.slice(page.indexOf('@media (max-width: 820px)'));
	assert.match(pagePhone, /\.agent-chip \{[^}]*min-height:\s*44px/);
});

/** Clipped, not hidden: `display: none` would drop it from the a11y tree too. */
test('sr-only text stays in the accessibility tree', () => {
	const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	const rule = css.slice(css.indexOf('.sr-only {'), css.indexOf('.sr-only {') + 260);
	assert.ok(rule.startsWith('.sr-only {'), 'app.css declares .sr-only');
	assert.match(rule, /clip-path: inset\(50%\)/);
	assert.doesNotMatch(rule, /display:\s*none|visibility:\s*hidden/);
});
