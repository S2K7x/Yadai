import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import {
	formatBytes,
	formatCost,
	formatCount,
	formatNumber,
	formatTokens
} from '../src/lib/format.ts';
import { usageSummary } from '../src/lib/sessions.ts';
import { source } from './source.ts';

// ---------------------------------------------------------------------------
// Bytes — previously two helpers, one of which stopped at the kilobyte
// ---------------------------------------------------------------------------

test('bytes read as French sizes, one decimal below ten', () => {
	assert.equal(formatBytes(8454012928), '7,9 Go');
	assert.equal(formatBytes(2918973440), '2,7 Go');
	assert.equal(formatBytes(251420790784), '234 Go');
	assert.equal(formatBytes(1024), '1 ko');
	assert.equal(formatBytes(1536), '1,5 ko');
	// A whole value keeps no trailing zero.
	assert.equal(formatBytes(2 * 1024 ** 3), '2 Go');
	assert.equal(formatBytes(512), '512 o');
	assert.equal(formatBytes(0), '0 o');
});

test('a missing or nonsensical byte count says so instead of printing NaN', () => {
	assert.equal(formatBytes(undefined), '—');
	assert.equal(formatBytes(null), '—');
	assert.equal(formatBytes(-1), '—');
	assert.equal(formatBytes(Number.NaN), '—');
});

/**
 * The cases the skills editor's own helper got wrong.
 *
 * It wrote a decimal point into a French interface and had no unit above the
 * kilobyte, so the composer announced a dropped 5 Mo file as `5120 Ko` and the
 * 512 ko ceiling it was explaining sat right next to it.
 */
test('a byte count above a kilobyte climbs the ladder', () => {
	assert.equal(formatBytes(2048), '2 ko');
	assert.equal(formatBytes(200_000), '195 ko');
	assert.equal(formatBytes(5 * 1024 ** 2), '5 Mo');
	assert.equal(formatBytes(400 * 1024 ** 2), '400 Mo');
	// And the one the status panel's `(free / 1024 ** 3).toFixed(0)` read as
	// "0 Go libres" about a card that still had room.
	assert.notEqual(formatBytes(419_430_400), '0 Go');
});

// ---------------------------------------------------------------------------
// Tokens, counts, costs
// ---------------------------------------------------------------------------

test('a token count stays short enough for a tile', () => {
	assert.equal(formatTokens(0), '0');
	assert.equal(formatTokens(53), '53');
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(1000), '1 k');
	assert.equal(formatTokens(6105), '6,1 k');
	assert.equal(formatTokens(99_900), '99,9 k');
	assert.equal(formatTokens(670_657), '671 k');
	assert.equal(formatTokens(2_400_000), '2,4 M');
	assert.equal(formatTokens(-1), '—');
	assert.equal(formatTokens(NaN), '—');
});

test('an exact count is grouped, not abbreviated', () => {
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(36), '36');
	assert.equal(formatCount(1234), '1 234');
	assert.equal(formatCount(1234567), '1 234 567');
	assert.equal(formatCount(NaN), '—');
});

/**
 * Four decimals below a dollar: a turn on a cheap model costs fractions of a
 * cent, and rounding those to `0,00 $` reports "free" about something that
 * is not.
 */
test('a cost is never rounded into a false zero', () => {
	assert.equal(formatCost(0), '0 $');
	assert.equal(formatCost(0.0004), '0,0004 $');
	assert.equal(formatCost(0.5), '0,5 $');
	assert.equal(formatCost(12.5), '12,5 $');
	assert.equal(formatCost(12.345), '12,35 $');
	assert.equal(formatCost(-1), '—');
});

test('numbers carry a comma, like every other number on screen', () => {
	assert.equal(formatNumber(0.291015625), '0,29');
	assert.equal(formatNumber(3), '3,00');
	assert.equal(formatNumber(12.5, 1), '12,5');
});

// ---------------------------------------------------------------------------
// The point of the module: one answer per quantity, wherever it is asked
// ---------------------------------------------------------------------------

/**
 * The header summary and the consumption panel describe the same session.
 *
 * Before this module they disagreed on both halves: the header's own renderer
 * wrote `21.5k ↓ / 412 ↑ · $0.0123` while the panel wrote `21,5 k` and
 * `0,0123 $` about the very same numbers.
 */
test('the header summary is written with the same formatters as the panel', () => {
	const line = usageSummary({
		id: 's1',
		input_tokens: 21_473,
		output_tokens: 412,
		estimated_cost_usd: 0.0123
	});
	assert.equal(line, `${formatTokens(21_473)} ↓ / ${formatTokens(412)} ↑ · ${formatCost(0.0123)}`);
	assert.equal(line, '21,5 k ↓ / 412 ↑ · 0,0123 $');
});

test('a million tokens is a million, not a four-digit thousand', () => {
	const line = usageSummary({ id: 's1', input_tokens: 1_500_000, output_tokens: 0 });
	assert.ok(line?.startsWith('1,5 M '), line ?? 'no summary');
});

/**
 * No module but this one may decide how a quantity is written.
 *
 * Both halves matter. A second *definition* is how bytes came to be rendered
 * two ways; a second decimal separator is how `2.0 Ko` ended up in an interface
 * that is otherwise entirely in French. The exception list is the vocabulary of
 * the upstream API and of the browser — `toFixed` on a contrast ratio, a
 * percentage, a CSS value — none of which is a quantity shown to the user.
 */
test('the formatters are defined once, and only here', () => {
	const under = (dir: string, ext: string) =>
		readdirSync(new URL(`../${dir}`, import.meta.url))
			.filter((f) => f.endsWith(ext) && f !== 'format.ts')
			.map((f) => `${dir}/${f}`);
	const files = [
		...under('src/lib', '.ts'),
		...under('src/lib/server', '.ts'),
		...under('src/lib/client', '.ts'),
		...under('src/lib/stores', '.ts'),
		...under('src/lib/components', '.svelte')
	];
	for (const file of files) {
		const src = source(file);
		assert.doesNotMatch(
			src,
			/(function|const)\s+(formatBytes|formatTokens|formatCount|formatCost|formatNumber|fmtTokens)\b/,
			`${file} must import its formatters from $lib/format, not define its own`
		);
		assert.doesNotMatch(
			src,
			/replace\('\.', ','\)/,
			`${file} must not decide the decimal separator — $lib/format does`
		);
	}
});
