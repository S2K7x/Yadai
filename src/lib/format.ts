/**
 * How this app writes a quantity. Once.
 *
 * Bytes, tokens and dollars were each rendered two different ways depending on
 * which screen you were looking at, because each screen grew its own helper:
 *
 * | | header / sidebar | consumption panel |
 * |---|---|---|
 * | tokens | `6.1k` (`fmtTokens`, `sessions.ts`) | `6,1 k` (`formatTokens`, `usage.ts`) |
 * | cost | `$0.0012` (`sessions.ts`) | `0,0012 $` (`usage.ts`) |
 * | bytes | `2.0 Ko` (`skills.ts`) | `2 ko` (`system.ts`) |
 *
 * Same numbers, same app, three disagreements — including the decimal
 * separator, in an interface that is otherwise entirely in French. And the
 * losing halves were not merely inconsistent but short: `fmtTokens` had no
 * million (1,5 M read `1500.0k`) and the skills helper no megabyte, so a
 * dropped 5 Mo file was announced as `5120.0 Ko`.
 *
 * So: one definition each, here, and `comma()` as the single place that decides
 * that a decimal point is a comma. Same reasoning as `src/lib/text.ts` being
 * the only definition of "ça correspond" — a formatting rule written twice is a
 * formatting rule that has already diverged.
 */

/** A fixed-decimal string, French: no trailing zero, comma for the point. */
const comma = (text: string) =>
	(text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text).replace('.', ',');

/** A number with a comma for a decimal point, trailing zeros kept. */
export function formatNumber(value: number, digits = 2): string {
	return value.toFixed(digits).replace('.', ',');
}

/**
 * A byte count, in the units a French reader expects.
 *
 * Powers of 1024, like the disk line the readiness check already prints in the
 * same panel as the memory row: two different conventions side by side would be
 * worse than the approximation either of them makes.
 */
export function formatBytes(bytes: number | undefined | null): string {
	if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
	const units = ['o', 'ko', 'Mo', 'Go', 'To'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	// One decimal below ten, none above: "7,9 Go" then "234 Go".
	const rounded = value < 10 && unit > 0 ? value.toFixed(1) : String(Math.round(value));
	return `${rounded.replace('.', ',').replace(/,0$/, '')} ${units[unit]}`;
}

/** A token count, short enough to fit a tile: `53`, `6,1 k`, `671 k`, `2,4 M`. */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value < 0) return '—';
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const k = value / 1000;
		return `${comma(k < 100 ? k.toFixed(1) : String(Math.round(k)))} k`;
	}
	return `${comma((value / 1_000_000).toFixed(2))} M`;
}

/** An exact count, grouped with non-breaking spaces: `12 345`. */
export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value < 0) return '—';
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * A cost in dollars, French style.
 *
 * Four decimals below a dollar: a turn on a cheap model costs fractions of a
 * cent, and rounding those to `0,00 $` would report "free" about something
 * that is not. Zero stays zero — see `costNote()` in `usage.ts` for why that is
 * not the same claim.
 */
export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value < 0) return '—';
	if (value === 0) return '0 $';
	return `${comma(value < 1 ? value.toFixed(4) : value.toFixed(2))} $`;
}
