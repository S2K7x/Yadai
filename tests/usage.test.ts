import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_USAGE_PERIOD,
	USAGE_PERIODS,
	costNote,
	dailyBars,
	dayLabel,
	emptyReport,
	formatCost,
	formatCount,
	formatTokens,
	hasUsage,
	modelDetail,
	modelShares,
	normalizeUsage,
	periodLabel,
	resolvePeriod,
	toolShares
} from '../src/lib/usage.ts';

/**
 * The fixture is the real answer of `GET /api/analytics/usage?days=30` on this
 * Pi, trimmed to the fields this app reads. Six days of activity inside a
 * thirty-day window is what makes the gap filling worth testing: drawn as it
 * arrives it reads as six consecutive days.
 */
const PAYLOAD = {
	daily: [
		{
			day: '2026-09-07',
			input_tokens: 18559,
			output_tokens: 53,
			cache_read_tokens: 1280,
			reasoning_tokens: 42,
			estimated_cost: 0.0,
			actual_cost: 0,
			sessions: 1,
			api_calls: 1
		},
		{
			day: '2026-09-10',
			input_tokens: 418551,
			output_tokens: 3991,
			cache_read_tokens: 76480,
			reasoning_tokens: 2395,
			estimated_cost: 0.0,
			actual_cost: 0,
			sessions: 2,
			api_calls: 21
		},
		{
			day: '2026-10-02',
			input_tokens: 19839,
			output_tokens: 89,
			cache_read_tokens: 0,
			reasoning_tokens: 64,
			estimated_cost: 0.0,
			actual_cost: 0,
			sessions: 2,
			api_calls: 1
		}
	],
	by_model: [
		{
			model: 'openrouter/free',
			input_tokens: 670657,
			output_tokens: 6105,
			estimated_cost: 0.0,
			sessions: 8,
			api_calls: 36
		},
		{
			model: 'claude-sonnet-5',
			input_tokens: 0,
			output_tokens: 0,
			estimated_cost: 0,
			sessions: 1,
			api_calls: 0
		}
	],
	by_task: [],
	totals: {
		total_input: 670657,
		total_output: 6105,
		total_cache_read: 171664,
		total_reasoning: 3398,
		total_estimated_cost: 0.0,
		total_actual_cost: 0,
		total_sessions: 9,
		total_api_calls: 36
	},
	period_days: 30,
	skills: {
		summary: { total_skill_loads: 1 },
		top_skills: [{ skill: 'maps', view_count: 1, manage_count: 0, total_count: 1 }]
	},
	tools: [
		{ tool: 'terminal', count: 16, percentage: 64.0 },
		{ tool: 'web_search', count: 4, percentage: 16.0 },
		{ tool: 'skill_view', count: 1, percentage: 4.0 }
	]
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('the measured payload comes through field by field', () => {
	const report = normalizeUsage(PAYLOAD);
	assert.equal(report.periodDays, 30);
	assert.equal(report.days.length, 3);
	assert.equal(report.days[0].day, '2026-09-07');
	assert.equal(report.days[1].inputTokens, 418551);
	assert.equal(report.totals.inputTokens, 670657);
	assert.equal(report.totals.cacheReadTokens, 171664);
	assert.equal(report.totals.sessions, 9);
	assert.equal(report.totals.apiCalls, 36);
	assert.equal(report.tools[0].tool, 'terminal');
	assert.equal(report.skills[0].skill, 'maps');
});

test('models are ordered by the tokens they moved', () => {
	const report = normalizeUsage({
		by_model: [
			{ model: 'small', input_tokens: 10, output_tokens: 1 },
			{ model: 'big', input_tokens: 900, output_tokens: 100 }
		]
	});
	assert.deepEqual(
		report.models.map((m) => m.model),
		['big', 'small']
	);
});

test('a billed cost wins over the estimate, and says so', () => {
	const billed = normalizeUsage({
		totals: { total_estimated_cost: 1.5, total_actual_cost: 2.25 }
	});
	assert.equal(billed.totals.cost, 2.25);
	assert.equal(billed.totals.estimated, false);

	const guessed = normalizeUsage({
		totals: { total_estimated_cost: 1.5, total_actual_cost: 0 }
	});
	assert.equal(guessed.totals.cost, 1.5);
	assert.equal(guessed.totals.estimated, true);
});

test('nothing in the payload is required', () => {
	for (const raw of [null, undefined, {}, [], 'nope', 42, { daily: 'x', totals: 7 }]) {
		const report = normalizeUsage(raw, 7);
		assert.equal(report.periodDays, 7);
		assert.deepEqual(report.days, []);
		assert.deepEqual(report.models, []);
		assert.equal(report.totals.inputTokens, 0);
		assert.equal(hasUsage(report), false);
	}
});

test('a row without a name is dropped rather than labelled "undefined"', () => {
	const report = normalizeUsage({
		by_model: [{ input_tokens: 10 }, { model: '', input_tokens: 5 }, { model: 'ok' }],
		tools: [{ count: 3 }, { tool: 'terminal', count: 0 }, { tool: 'web_search', count: 2 }]
	});
	assert.deepEqual(
		report.models.map((m) => m.model),
		['ok']
	);
	// A tool counted zero times is not a tool the agent reached for.
	assert.deepEqual(
		report.tools.map((t) => t.tool),
		['web_search']
	);
});

test('an empty period is distinguishable from a measured one', () => {
	assert.equal(hasUsage(emptyReport()), false);
	assert.equal(hasUsage(normalizeUsage(PAYLOAD)), true);
	// Sessions with no tokens yet still count as activity.
	assert.equal(hasUsage(normalizeUsage({ totals: { total_sessions: 1 } })), true);
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

test('only the three offered windows reach upstream', () => {
	for (const period of USAGE_PERIODS) assert.equal(resolvePeriod(period), period);
	for (const period of USAGE_PERIODS) assert.equal(resolvePeriod(String(period)), period);
	for (const bogus of [null, undefined, '', 'month', 0, -7, 1, 365, 4000, NaN, Infinity, {}]) {
		assert.equal(resolvePeriod(bogus), DEFAULT_USAGE_PERIOD);
	}
});

test('a window is named in words', () => {
	assert.equal(periodLabel(7), '7 jours');
	assert.equal(periodLabel(90), '90 jours');
});

// ---------------------------------------------------------------------------
// The daily axis — the part that would quietly lie
// ---------------------------------------------------------------------------

const AT = (iso: string) => Date.parse(`${iso}T09:00:00Z`);

test('the days upstream skipped are drawn as zero, not closed up', () => {
	const bars = dailyBars(normalizeUsage(PAYLOAD), AT('2026-10-06'));
	// A 30-day window ending today: 2026-09-07 is 29 days back, so the axis
	// starts there and the three measured days keep their real distance.
	assert.equal(bars[0].day, '2026-09-07');
	assert.equal(bars[bars.length - 1].day, '2026-10-06');
	assert.equal(bars.length, 30);
	const measured = bars.filter((b) => b.tokens > 0);
	assert.deepEqual(
		measured.map((b) => b.day),
		['2026-09-07', '2026-09-10', '2026-10-02']
	);
	// And the gap between the first two is two empty days, not none.
	assert.equal(bars[1].tokens, 0);
	assert.equal(bars[2].tokens, 0);
	assert.equal(bars[3].day, '2026-09-10');
});

test('the axis never runs past today, and always reaches it', () => {
	const bars = dailyBars(normalizeUsage({ daily: [], period_days: 7 }), AT('2026-03-12'));
	assert.equal(bars.length, 7);
	assert.equal(bars[0].day, '2026-03-06');
	assert.equal(bars[6].day, '2026-03-12');
	assert.ok(bars.every((b) => b.tokens === 0 && b.share === 0));
});

test('a bucket older than the window still gets a bar', () => {
	// Upstream cuts on `now - days × 86400`, an instant and not a midnight, so
	// a 7-day window legitimately touches 8 UTC days.
	const report = normalizeUsage({
		period_days: 7,
		daily: [{ day: '2026-03-05', input_tokens: 10 }, { day: '2026-03-12', input_tokens: 20 }]
	});
	const bars = dailyBars(report, AT('2026-03-12'));
	assert.equal(bars[0].day, '2026-03-05');
	assert.equal(bars.length, 8);
	assert.equal(bars[0].tokens, 10);
});

test('one corrupt date cannot ask for twenty thousand bars', () => {
	const report = normalizeUsage({
		period_days: 7,
		daily: [{ day: '1970-01-01', input_tokens: 1 }, { day: '2026-03-12', input_tokens: 20 }]
	});
	const bars = dailyBars(report, AT('2026-03-12'));
	assert.ok(bars.length <= 8, `axis grew to ${bars.length} bars`);
	assert.equal(bars[bars.length - 1].day, '2026-03-12');
});

test('a day that is not a date is ignored instead of shifting the axis', () => {
	const report = normalizeUsage({
		period_days: 7,
		daily: [{ day: 'hier', input_tokens: 99 }, { day: '2026-03-10', input_tokens: 5 }]
	});
	const bars = dailyBars(report, AT('2026-03-12'));
	assert.equal(bars.length, 7);
	assert.equal(
		bars.reduce((sum, b) => sum + b.tokens, 0),
		5
	);
});

test('bar heights are relative to the tallest day of the period', () => {
	const report = normalizeUsage({
		period_days: 7,
		daily: [
			{ day: '2026-03-10', input_tokens: 50, output_tokens: 50 },
			{ day: '2026-03-12', input_tokens: 400 }
		]
	});
	const bars = dailyBars(report, AT('2026-03-12'));
	const tenth = bars.find((b) => b.day === '2026-03-10');
	const twelfth = bars.find((b) => b.day === '2026-03-12');
	assert.equal(twelfth?.share, 1);
	assert.equal(tenth?.share, 0.25);
});

/**
 * The buckets are `date(started_at, 'unixepoch')` — UTC, with no timezone
 * argument anywhere in the upstream SQL. Parsing one into a local instant is
 * the off-by-one `localDay()` exists to avoid in the sidebar, arrived at from
 * the other side: it would move this morning's work to yesterday for every
 * reader east of Greenwich.
 */
test('a bucket is labelled from its own fields, not re-timezoned', () => {
	assert.equal(dayLabel('2026-10-06'), '6 oct.');
	assert.equal(dayLabel('2026-01-01'), '1 janv.');
	assert.equal(dayLabel('2026-08-31'), '31 août');
	assert.equal(dayLabel('pas-une-date'), 'pas-une-date');

	const report = normalizeUsage({ period_days: 7, daily: [{ day: '2026-03-12', input_tokens: 1 }] });
	for (const tz of ['UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati', 'Pacific/Niue']) {
		process.env.TZ = tz;
		const bars = dailyBars(report, AT('2026-03-12'));
		const hit = bars.find((b) => b.tokens > 0);
		assert.equal(hit?.day, '2026-03-12', `shifted in ${tz}`);
		assert.equal(hit?.label, '12 mars', `relabelled in ${tz}`);
	}
	delete process.env.TZ;
});

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

test('shares are taken against the list, and sum to one', () => {
	const report = normalizeUsage(PAYLOAD);
	const models = modelShares(report);
	assert.equal(models[0].item.model, 'openrouter/free');
	assert.equal(models[0].share, 1);
	// The row with no tokens is kept — it has a session to report.
	assert.equal(models[1].share, 0);

	const tools = toolShares(report);
	assert.equal(tools.length, 3);
	assert.ok(Math.abs(tools.reduce((s, t) => s + t.share, 0) - 1) < 1e-9);
	assert.ok(Math.abs(tools[0].share - 16 / 21) < 1e-9);
});

test('a period with nothing in it divides by nothing', () => {
	const report = emptyReport();
	assert.deepEqual(modelShares(report), []);
	assert.deepEqual(toolShares(report), []);
	const zeroed = normalizeUsage({ by_model: [{ model: 'a' }, { model: 'b' }] });
	assert.ok(modelShares(zeroed).every((r) => r.share === 0));
});

test('the tool list is capped so a long tail cannot fill the panel', () => {
	const many = Array.from({ length: 30 }, (_, i) => ({ tool: `t${i}`, count: 30 - i }));
	const report = normalizeUsage({ tools: many });
	assert.equal(toolShares(report).length, 8);
	assert.equal(toolShares(report, 3).length, 3);
	assert.equal(toolShares(report, 0).length, 0);
});

/**
 * Both zeroes below really occur, measured on this host's 90-day window: a
 * session row exists before its first billable call, and an auxiliary-only
 * model (folded in upstream) never increments the session counter at all.
 * Printed naively the line read "0 appels · 1 sessions".
 */
test("a model's detail line drops zeroes and spells its singulars", () => {
	const base = { model: 'm', inputTokens: 0, outputTokens: 0, cost: 0, sessions: 0, apiCalls: 0 };
	assert.equal(modelDetail(base), '');
	assert.equal(modelDetail({ ...base, apiCalls: 1 }), '1 appel');
	assert.equal(modelDetail({ ...base, sessions: 1 }), '1 session');
	assert.equal(modelDetail({ ...base, apiCalls: 11, sessions: 3 }), '11 appels · 3 sessions');
	assert.equal(modelDetail({ ...base, apiCalls: 2, cost: 0.5 }), '2 appels · 0,5 $');
	// A free model says nothing about cost rather than claiming zero.
	assert.equal(modelDetail({ ...base, apiCalls: 2, cost: 0 }), '2 appels');
});

// ---------------------------------------------------------------------------
// Formatting
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
	assert.equal(formatCount(1234), '1 234');
	assert.equal(formatCount(1234567), '1 234 567');
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

/**
 * `estimated_cost_usd` is zero both for a free model and for one whose price
 * Hermes never learned — only openrouter / nous / novita carry pricing
 * (point 33). Printing `0 $` alone would turn a missing measurement into a
 * promise.
 */
test('a zero cost is explained rather than claimed as free', () => {
	const free = normalizeUsage(PAYLOAD);
	const note = costNote(free);
	assert.ok(note && /gratuits|inconnu/.test(note), note ?? 'no note');

	const paid = normalizeUsage({
		totals: { total_input: 10, total_estimated_cost: 3, total_actual_cost: 0 }
	});
	assert.match(costNote(paid) ?? '', /estim/i);

	const billed = normalizeUsage({
		totals: { total_input: 10, total_estimated_cost: 3, total_actual_cost: 4 }
	});
	assert.match(costNote(billed) ?? '', /fournisseur/i);

	// Nothing measured: no sentence at all, rather than one about free models.
	assert.equal(costNote(emptyReport()), null);
});

// ---------------------------------------------------------------------------
// The route's half of the contract
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(new URL('../src/routes/api/usage/+server.ts', import.meta.url), 'utf8');

test('the route reshapes the upstream answer instead of forwarding it', () => {
	// Upstream's payload carries per-model capability metadata, auxiliary-task
	// breakdowns and per-skill timestamps this panel never draws. Forwarding it
	// whole is how a route stops having a contract.
	assert.match(ROUTE, /normalizeUsage\(/);
	assert.match(ROUTE, /resolvePeriod\(/);
});

test('a missing token disables the panel; a failed read does not', () => {
	// Point 4 of the error contract: "I could not read" is not "it is turned
	// off". Measured on this host against the real dashboard — an empty token
	// answers `disabled`, a refused token and an unreachable dashboard answer
	// `failed`, which the panel retries on the next opening instead of
	// printing a configuration remedy about something that is running.
	assert.match(ROUTE, /dashboardConfigured\(\)/);
	assert.match(ROUTE, /gate\('usage:read'/);
	assert.match(ROUTE, /reason: 'disabled'/);
	assert.match(ROUTE, /reason: 'failed'/);

	const store = readFileSync(
		new URL('../src/lib/stores/usage.svelte.ts', import.meta.url),
		'utf8'
	);
	assert.match(store, /res\.reason === 'disabled'/);
	// And the store must route the other branch to loadError, which
	// `panelState` ranks above `unavailable`.
	assert.match(store, /else \{[\s\S]{0,400}this\.loadError = res\.message/);
});

const PAGE = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');

/**
 * A modal panel owns Escape, and the page must stand down while one is open.
 *
 * Both handlers sit on `<svelte:window>`, and `preventDefault()` does not stop
 * a sibling listener on the same target: without this guard, the Escape that
 * closes the panel also reaches the page's own branch, where — mid-turn — it
 * means `chat.stop()`. That is the hazard point 22 documents for popup menus,
 * one layer up.
 */
test('the page stands down from its shortcuts while a modal panel is open', () => {
	const guard = /if \(\s*skillsOpen \|\|[\s\S]{0,260}?\)\s*\n?\s*return;/.exec(PAGE);
	assert.ok(guard, 'the modal shortcut guard moved');
	for (const flag of ['usageOpen', 'approvalsOpen', 'themeOpen', 'jobsOpen']) {
		assert.ok(guard[0].includes(flag), `${flag} must suspend the page shortcuts`);
	}
});

test('the panel is reachable from the command palette, like its siblings', () => {
	assert.match(PAGE, /id: 'usage'[\s\S]{0,80}usageOpen = true/);
});
