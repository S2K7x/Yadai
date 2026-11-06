import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { REDUCED_MOTION_QUERY, motionMs, scrollMotion } from '../src/lib/motion.ts';

/**
 * "Reduce Motion" is a system setting, so it has to be answered in both the
 * places this app moves things: the stylesheet, and the script.
 *
 * The pure half is small on purpose — what it buys is one definition of the
 * policy instead of a `matchMedia` call at each site. The source-reading tests
 * below are the real guard: they are what fails if a new animation, transition
 * or smooth scroll is added without an answer for someone who asked for less
 * of it.
 */

test('a scripted animation is asked to end where it meant to', () => {
	assert.equal(motionMs(180, false), 180);
	assert.equal(motionMs(180, true), 0);
	// A rounded, non-negative number of milliseconds, whatever comes in.
	assert.equal(motionMs(160.4, false), 160);
	assert.equal(motionMs(-5, false), 0);
	assert.equal(motionMs(Number.NaN, false), 0);
});

test('a scripted scroll lands instead of travelling', () => {
	assert.equal(scrollMotion(false), 'smooth');
	assert.equal(scrollMotion(true), 'auto');
});

test('both halves name the same media query', () => {
	assert.equal(REDUCED_MOTION_QUERY, '(prefers-reduced-motion: reduce)');
	const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	assert.ok(css.includes(`@media ${REDUCED_MOTION_QUERY}`), 'app.css answers the query');
});

/**
 * Transitions are cut once, globally, because a transition's end state is the
 * state the app wanted: the drawer still arrives open, the chevron still ends
 * up turned. Cutting them per component is how five of them came to be left
 * out in the first place.
 */
test('app.css cuts every transition and every CSS scroll', () => {
	const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
	const block = css.slice(css.indexOf(`@media ${REDUCED_MOTION_QUERY}`));
	const rule = block.slice(0, block.indexOf('\n}\n\n'));
	assert.match(rule, /\*,\s*\n\s*\*::before,\s*\n\s*\*::after \{/);
	assert.match(rule, /transition-duration:\s*0\.01ms\s*!important/);
	assert.match(rule, /scroll-behavior:\s*auto/);
	// Animations must NOT be cut from here: a looping indicator would land on
	// its invisible keyframe and the turn would lose its only visible sign.
	assert.doesNotMatch(rule, /animation/);
});

/**
 * A looping animation is the one kind the global rule cannot touch, so every
 * component that declares one owes a still form in the same file. Three do
 * today: the streaming caret, the waiting dots, the running tool's dot.
 */
test('every looping animation has a still form in its own file', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith('.svelte'));
	assert.ok(files.length > 10, 'the components should be there');
	let looping = 0;
	for (const name of files) {
		const source = readFileSync(new URL(name, dir), 'utf8');
		const loops = source.match(/animation:[^;]*\binfinite\b/g)?.length ?? 0;
		if (!loops) continue;
		looping += loops;
		assert.ok(
			source.includes(`@media (prefers-reduced-motion: reduce)`),
			`${name} loops an animation and never answers Reduce Motion`
		);
		const stills = source.match(/animation:\s*none/g)?.length ?? 0;
		assert.ok(stills >= loops, `${name} loops ${loops} animations but stills only ${stills}`);
	}
	assert.equal(looping, 3, 'the caret, the waiting dots and the running dot');
});

/** Those three stills must stay *visible*, which is the whole point. */
test('the stilled indicators are still on screen', () => {
	const dir = new URL('../src/lib/components/', import.meta.url);
	const message = readFileSync(new URL('Message.svelte', dir), 'utf8');
	const reduced = message.slice(message.indexOf('@media (prefers-reduced-motion: reduce)'));
	assert.match(reduced, /:last-child::after\) \{\s*animation: none;\s*opacity: 1;/);
	assert.match(reduced, /\.thinking span \{\s*animation: none;\s*opacity: 1;/);

	const steps = readFileSync(new URL('ToolSteps.svelte', dir), 'utf8');
	const stepsReduced = steps.slice(steps.indexOf('@media (prefers-reduced-motion: reduce)'));
	assert.match(stepsReduced, /\.pulse \{\s*animation: none;\s*opacity: 1;/);
});

/**
 * A Svelte transition is a keyframe animation injected by script: no
 * stylesheet reaches it, so the toast stack has to ask for its durations.
 */
test('the toast stack asks for its durations', () => {
	const source = readFileSync(
		new URL('../src/lib/components/Toasts.svelte', import.meta.url),
		'utf8'
	);
	assert.match(source, /import \{ moveMs \} from '\$lib\/client\/motion'/);
	for (const name of ['flip', 'fly']) {
		assert.ok(source.includes(`:${name}=`), `the stack still uses ${name}`);
	}
	assert.doesNotMatch(source, /duration:\s*\d/, 'a literal duration ignores the setting');
	assert.equal(source.match(/duration: moveMs\(/g)?.length, 3);
});

/**
 * `behavior: 'smooth'` is the only motion here that moves the whole thread
 * under the reader, and a stylesheet cannot override an explicit argument.
 */
test('no scripted scroll hard-codes smooth', () => {
	const roots = [new URL('../src/lib/', import.meta.url), new URL('../src/routes/', import.meta.url)];
	const seen: string[] = [];
	const walk = (dir: URL) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
			if (entry.isDirectory()) {
				walk(child);
				continue;
			}
			if (!/\.(ts|svelte)$/.test(entry.name)) continue;
			const source = readFileSync(child, 'utf8');
			if (/behavior:\s*'smooth'/.test(source)) seen.push(entry.name);
		}
	};
	for (const root of roots) walk(root);
	assert.deepEqual(seen, [], 'these pass smooth whatever the reader asked for');

	const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
	assert.match(page, /import \{ scrollBehavior \} from '\$lib\/client\/motion'/);
	// The jump to a found passage, and the jump-to-bottom button.
	assert.equal(page.match(/behavior: scrollBehavior\(\)/g)?.length, 2);
});
