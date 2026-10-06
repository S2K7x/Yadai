/**
 * What the agent has actually consumed — which Hermes already measures, and
 * nobody here had ever read.
 *
 * `GET /api/analytics/usage` (`hermes_cli/web_server.py`) answers from the
 * session database: tokens per day, tokens and cost per model, the tool names
 * the agent called and the skills it loaded. Measured on this Pi through the
 * dashboard, ten samples each: **8–16 ms** for 7, 30 and 90 days (1.1 ko,
 * 2.1 ko, 3.8 ko). It is a read of `~/.hermes/state.db`, not a provider
 * round-trip, so it costs nothing worth caching.
 *
 * Three things this module exists to keep honest, all three verified against
 * the upstream SQL rather than assumed:
 *
 * 1. **The days are UTC calendar days.** The query groups on
 *    `date(started_at, 'unixepoch')`, with no timezone argument. Re-labelling
 *    those buckets in local time would shift every bar by a few hours and put
 *    this morning's work on yesterday — the same off-by-one `localDay()`
 *    exists to avoid in the sidebar (point 24), arrived at from the other
 *    side. So the bucket string is formatted as the calendar label it already
 *    is, never parsed into an instant.
 * 2. **A day with no session is missing from the answer, not zero.** Six rows
 *    came back for a 30-day window on this machine. Drawn as they arrive they
 *    read as six consecutive days; `dailyBars()` therefore lays them on a
 *    continuous axis and fills the gaps.
 * 3. **`sessions` is Hermes sessions, not conversations.** A compression
 *    rotates a conversation onto a fresh session row (point 23), and the CLI,
 *    Telegram and the scheduled jobs all create their own. The number is the
 *    agent's whole workload — which is the interesting reading, as long as the
 *    panel says so instead of implying it counted this app's sidebar.
 *
 * Everything below is pure, so it is tested without a browser; every field is
 * optional because this is JSON we did not write.
 */

// ---------------------------------------------------------------------------
// The upstream payload
// ---------------------------------------------------------------------------

/** One UTC calendar day of activity. */
export interface UsageDay {
	/** `YYYY-MM-DD`, in UTC. A label, never an instant. */
	day: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	cost: number;
	sessions: number;
	apiCalls: number;
}

/** One model, with auxiliary usage already folded in upstream. */
export interface UsageModel {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	sessions: number;
	apiCalls: number;
}

/** One tool name and how often the agent called it. */
export interface UsageTool {
	tool: string;
	count: number;
}

/** One skill and how often it was loaded or edited. */
export interface UsageSkill {
	skill: string;
	count: number;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	/** Provider-reported cost when there is one, our estimate otherwise. */
	cost: number;
	/** True when `cost` is the estimate rather than a billed amount. */
	estimated: boolean;
	sessions: number;
	apiCalls: number;
}

export interface UsageReport {
	periodDays: number;
	days: UsageDay[];
	models: UsageModel[];
	tools: UsageTool[];
	skills: UsageSkill[];
	totals: UsageTotals;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The three windows offered, matching the presets upstream documents. */
export const USAGE_PERIODS = [7, 30, 90] as const;

export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const DEFAULT_USAGE_PERIOD: UsagePeriod = 30;

/**
 * Coerce anything into one of the three windows.
 *
 * Upstream clamps `days` to 1–365 and would happily answer 4 or 211, but this
 * panel only ever asks for three values and the route must not become a way to
 * make the Pi read a year of sessions on request.
 */
export function resolvePeriod(value: unknown): UsagePeriod {
	const n = typeof value === 'string' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_USAGE_PERIOD;
	return (USAGE_PERIODS as readonly number[]).includes(n)
		? (n as UsagePeriod)
		: DEFAULT_USAGE_PERIOD;
}

export function periodLabel(days: number): string {
	return days === 7 ? '7 jours' : days === 90 ? '90 jours' : `${days} jours`;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const num = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const rows = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
		: [];

export function emptyReport(periodDays: number = DEFAULT_USAGE_PERIOD): UsageReport {
	return {
		periodDays,
		days: [],
		models: [],
		tools: [],
		skills: [],
		totals: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			reasoningTokens: 0,
			cost: 0,
			estimated: true,
			sessions: 0,
			apiCalls: 0
		}
	};
}

/**
 * The upstream payload, in this app's shape.
 *
 * Nothing is validated beyond the `typeof` guards above: these columns are
 * SQL sums we did not write, and a missing one means zero rather than an
 * error. Rows without a model name are dropped — upstream already filters
 * `model IS NOT NULL` on the per-model query, so one here would be a row we
 * cannot label.
 */
export function normalizeUsage(raw: unknown, fallbackDays = DEFAULT_USAGE_PERIOD): UsageReport {
	const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const totalsRaw = (
		body.totals && typeof body.totals === 'object' ? body.totals : {}
	) as Record<string, unknown>;

	const actual = num(totalsRaw.total_actual_cost);
	const estimated = num(totalsRaw.total_estimated_cost);

	const days: UsageDay[] = rows(body.daily)
		.map((r) => ({
			day: str(r.day),
			inputTokens: num(r.input_tokens),
			outputTokens: num(r.output_tokens),
			cacheReadTokens: num(r.cache_read_tokens),
			reasoningTokens: num(r.reasoning_tokens),
			cost: num(r.actual_cost) || num(r.estimated_cost),
			sessions: num(r.sessions),
			apiCalls: num(r.api_calls)
		}))
		.filter((d) => d.day.length > 0);

	const models: UsageModel[] = rows(body.by_model)
		.map((r) => ({
			model: str(r.model),
			inputTokens: num(r.input_tokens),
			outputTokens: num(r.output_tokens),
			cost: num(r.estimated_cost),
			sessions: num(r.sessions),
			apiCalls: num(r.api_calls)
		}))
		.filter((m) => m.model.length > 0)
		.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

	const tools: UsageTool[] = rows(body.tools)
		.map((r) => ({ tool: str(r.tool), count: num(r.count) }))
		.filter((t) => t.tool.length > 0 && t.count > 0)
		.sort((a, b) => b.count - a.count);

	const skillsRaw =
		body.skills && typeof body.skills === 'object'
			? ((body.skills as Record<string, unknown>).top_skills as unknown)
			: undefined;
	const skills: UsageSkill[] = rows(skillsRaw)
		.map((r) => ({ skill: str(r.skill), count: num(r.total_count) }))
		.filter((s) => s.skill.length > 0 && s.count > 0)
		.sort((a, b) => b.count - a.count);

	return {
		periodDays: num(body.period_days) || fallbackDays,
		days,
		models,
		tools,
		skills,
		totals: {
			inputTokens: num(totalsRaw.total_input),
			outputTokens: num(totalsRaw.total_output),
			cacheReadTokens: num(totalsRaw.total_cache_read),
			reasoningTokens: num(totalsRaw.total_reasoning),
			// Same precedence as `usageSummary()` on a session row: a billed
			// amount when the provider reported one, our estimate otherwise.
			cost: actual || estimated,
			estimated: actual === 0,
			sessions: num(totalsRaw.total_sessions),
			apiCalls: num(totalsRaw.total_api_calls)
		}
	};
}

/** Did this period measure anything at all? */
export function hasUsage(report: UsageReport): boolean {
	const t = report.totals;
	return t.inputTokens + t.outputTokens + t.sessions + t.apiCalls > 0;
}

// ---------------------------------------------------------------------------
// The daily axis
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** A UTC `YYYY-MM-DD` to a day number, or null when it is not a date. */
function dayIndex(iso: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return null;
	const stamp = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isFinite(stamp) ? Math.round(stamp / MS_PER_DAY) : null;
}

const MONTHS = [
	'janv.',
	'févr.',
	'mars',
	'avr.',
	'mai',
	'juin',
	'juil.',
	'août',
	'sept.',
	'oct.',
	'nov.',
	'déc.'
];

/** `2026-10-06` → `6 oct.`, formatted from the string's own fields. */
export function dayLabel(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A day number back to `YYYY-MM-DD`, in UTC. */
function isoOfIndex(index: number): string {
	const d = new Date(index * MS_PER_DAY);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface UsageBar extends UsageDay {
	/** `6 oct.`, for the axis. */
	label: string;
	/** Tokens in + out, which is what the bar's height says. */
	tokens: number;
	/** 0–1 against the tallest bar of the period. */
	share: number;
}

/**
 * The period as a continuous run of days, gaps filled with zeroes.
 *
 * The axis ends on today (or on the last day upstream reported, if a clock
 * disagrees) and reaches back far enough to hold every bucket that came back.
 * Upstream's cutoff is `now - days × 86400`, an instant rather than a
 * midnight, so a `days`-long window legitimately touches `days + 1` UTC
 * calendar days — that is also the bound, so one corrupt date cannot ask for
 * twenty thousand bars.
 */
export function dailyBars(report: UsageReport, now: number = Date.now()): UsageBar[] {
	const byIndex = new Map<number, UsageDay>();
	for (const day of report.days) {
		const index = dayIndex(day.day);
		if (index !== null) byIndex.set(index, day);
	}

	const today = Math.floor(now / MS_PER_DAY);
	const indices = [...byIndex.keys()];
	const periodDays = report.periodDays > 0 ? report.periodDays : DEFAULT_USAGE_PERIOD;
	const end = indices.length ? Math.max(today, ...indices) : today;
	const wanted = indices.length ? Math.min(end - periodDays + 1, ...indices) : end - periodDays + 1;
	const start = Math.max(wanted, end - periodDays);

	const bars: UsageBar[] = [];
	let tallest = 0;
	for (let index = start; index <= end; index++) {
		const iso = isoOfIndex(index);
		const found = byIndex.get(index);
		const day: UsageDay = found ?? {
			day: iso,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			reasoningTokens: 0,
			cost: 0,
			sessions: 0,
			apiCalls: 0
		};
		const tokens = day.inputTokens + day.outputTokens;
		if (tokens > tallest) tallest = tokens;
		bars.push({ ...day, day: iso, label: dayLabel(iso), tokens, share: 0 });
	}
	if (tallest > 0) for (const bar of bars) bar.share = bar.tokens / tallest;
	return bars;
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export interface ShareRow<T> {
	item: T;
	/** 0–1 of the period's total, so two lists read against the same scale. */
	share: number;
}

/** Models, biggest first, each with its share of the period's tokens. */
export function modelShares(report: UsageReport): ShareRow<UsageModel>[] {
	const total = report.models.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
	return report.models.map((item) => ({
		item,
		share: total > 0 ? (item.inputTokens + item.outputTokens) / total : 0
	}));
}

/** The most-called tools, capped, each with its share of all tool calls. */
export function toolShares(report: UsageReport, limit = 8): ShareRow<UsageTool>[] {
	const total = report.tools.reduce((sum, t) => sum + t.count, 0);
	return report.tools
		.slice(0, Math.max(0, limit))
		.map((item) => ({ item, share: total > 0 ? item.count / total : 0 }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A fixed-decimal string, French: no trailing zero, comma for the point. */
const comma = (text: string) =>
	(text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text).replace('.', ',');

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
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * A cost in dollars, French style.
 *
 * Four decimals below a dollar: a turn on a cheap model costs fractions of a
 * cent, and rounding those to `0,00 $` would report "free" about something
 * that is not. Zero stays zero — see `costNote()` for why that is not the same
 * claim.
 */
export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value < 0) return '—';
	if (value === 0) return '0 $';
	return `${comma(value < 1 ? value.toFixed(4) : value.toFixed(2))} $`;
}

/**
 * Why the cost may read zero, when it does.
 *
 * `estimated_cost_usd` is zero both for a free model and for a model whose
 * price Hermes never learned — the per-provider catalogue only carries pricing
 * for openrouter / nous / novita (point 33). Printing `0 $` without this line
 * would turn a missing measurement into a promise of free.
 */
export function costNote(report: UsageReport): string | null {
	if (!hasUsage(report)) return null;
	if (report.totals.cost > 0) {
		return report.totals.estimated
			? "Coût estimé à partir des tarifs que Hermes connaît ; aucun montant n'est facturé par cette interface."
			: 'Coût rapporté par le fournisseur.';
	}
	return 'Aucun coût enregistré : les modèles utilisés sont gratuits, ou leur tarif est inconnu de Hermes.';
}

/**
 * The second line of a model's row: calls, sessions, and a cost if there is
 * one.
 *
 * Zeroes are dropped rather than printed, because both of them really happen:
 * a session row exists before its first billable call (`0 appels`), and an
 * auxiliary-only model — a dedicated vision or compression model, folded in
 * upstream by `_merge_aux_into_by_model` — never increments the session
 * counter at all (`0 sessions`). Both were measured on this host's 90-day
 * window. Singulars are spelled out for the same reason: "1 appels" is the
 * tell of a line assembled rather than written.
 */
export function modelDetail(model: UsageModel): string {
	const parts: string[] = [];
	if (model.apiCalls > 0) {
		parts.push(`${formatCount(model.apiCalls)} ${model.apiCalls === 1 ? 'appel' : 'appels'}`);
	}
	if (model.sessions > 0) {
		parts.push(`${formatCount(model.sessions)} session${model.sessions === 1 ? '' : 's'}`);
	}
	if (model.cost > 0) parts.push(formatCost(model.cost));
	return parts.join(' · ');
}

export interface UsageTile {
	key: 'input' | 'output' | 'cost' | 'calls';
	label: string;
	value: string;
	detail: string;
}

/**
 * The four numbers worth reading first.
 *
 * Cache reads sit under the input tile rather than on their own: they are a
 * share of the prompt tokens, and on this machine the larger number
 * (172 k read against 671 k sent) is the interesting one precisely as a
 * fraction.
 */
export function usageTiles(report: UsageReport): UsageTile[] {
	const t = report.totals;
	return [
		{
			key: 'input',
			label: 'Tokens envoyés',
			value: formatTokens(t.inputTokens),
			detail: t.cacheReadTokens > 0 ? `dont ${formatTokens(t.cacheReadTokens)} lus en cache` : ''
		},
		{
			key: 'output',
			label: 'Tokens produits',
			value: formatTokens(t.outputTokens),
			detail: t.reasoningTokens > 0 ? `dont ${formatTokens(t.reasoningTokens)} de réflexion` : ''
		},
		{
			key: 'cost',
			label: t.estimated ? 'Coût estimé' : 'Coût',
			value: formatCost(t.cost),
			detail: ''
		},
		{
			key: 'calls',
			label: 'Appels au modèle',
			value: formatCount(t.apiCalls),
			detail: t.sessions > 0 ? `sur ${formatCount(t.sessions)} sessions Hermes` : ''
		}
	];
}
