/**
 * The reasoning-effort dial, which Hermes has always accepted and we never sent.
 *
 * Verified in `gateway/platforms/api_server.py` (0.20.0): every turn body of
 * `POST /api/sessions/{id}/chat/stream` may carry a `model_options` object, and
 * `_request_reasoning_config()` reads `model_options.reasoning.{enabled,effort}`
 * from it. The result lands on `AIAgent(reasoning_config=…)` — an explicit
 * per-request value wins over `agent.reasoning_effort` in `config.yaml`
 * (`request_reasoning_config if … is not None else _load_reasoning_config`).
 * It is the same knob the CLI's `/reasoning` sets; there is nothing new to ask
 * of Hermes here.
 *
 * Two properties of that upstream code shape everything below:
 *
 * - **The accepted efforts are a closed set** (`_REASONING_EFFORTS`), and
 *   anything outside it is *ignored* rather than rejected — the turn then runs
 *   on the gateway's configured default. So an unknown value can never fail a
 *   turn, but it can silently do nothing, which is why `AUTO` is an explicit
 *   choice here instead of an out-of-range string.
 * - **`model_options` stay request-scoped**, in upstream's own words. The value
 *   is not remembered on the session row, so it has to be re-sent with every
 *   single message — exactly like the agent's `system_message` (CLAUDE.md §18),
 *   and for the same reason it is composed server-side rather than by the
 *   browser.
 *
 * Each provider plugin translates the config for its own wire format
 * (`build_api_kwargs_extras`: OpenRouter → `extra_body.reasoning`, Copilot
 * clamps the effort to what the live catalogue lists, Anthropic → `thinking`
 * and skips Haiku, reasoning-mandatory Claude models get `verbosity` and no
 * `reasoning` field at all). A provider with no override ignores it. That is
 * what makes offering this dial safe: the worst case is a level that has no
 * effect, never a rejected request.
 */

import type { ModelOptions } from './types';

/**
 * What the picker offers: the six efforts upstream knows, plus `auto`.
 *
 * `auto` is *this app's* value, never sent: it means "send no `model_options`
 * and let Hermes' own `agent.reasoning_effort` decide", which is what the app
 * did before this dial existed and what a conversation starts on.
 */
export const REASONING_EFFORTS = [
	'auto',
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh'
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING: ReasoningEffort = 'auto';

/** Anything unrecognised reads as `auto` — including null, from a fresh row. */
export function normalizeReasoning(value: unknown): ReasoningEffort {
	if (typeof value !== 'string') return DEFAULT_REASONING;
	const text = value.trim().toLowerCase();
	return (REASONING_EFFORTS as readonly string[]).includes(text)
		? (text as ReasoningEffort)
		: DEFAULT_REASONING;
}

/** Upstream's shape for one turn's `model_options`, or nothing to send. */
export interface ReasoningModelOptions {
	reasoning: { enabled: boolean; effort?: ReasoningEffort };
}

/**
 * The `model_options` this conversation's next turn carries.
 *
 * `undefined` for `auto`: sending `{}` would be the same to Hermes, but the
 * absence says plainly that the request expresses no opinion. `none` maps to
 * `{enabled: false}` rather than `{effort: 'none'}` — upstream treats the two
 * identically, and the boolean is the form every provider plugin reads.
 */
export function reasoningModelOptions(
	effort: ReasoningEffort
): ReasoningModelOptions | undefined {
	if (effort === 'auto') return undefined;
	if (effort === 'none') return { reasoning: { enabled: false } };
	return { reasoning: { enabled: true, effort } };
}

const LABELS: Record<ReasoningEffort, string> = {
	auto: 'Auto',
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Max'
};

/** The word on the chip. */
export const reasoningLabel = (effort: ReasoningEffort): string => LABELS[effort];

const HINTS: Record<ReasoningEffort, string> = {
	auto: 'Let Hermes decide, from its own configuration',
	none: 'No thinking first: the fastest',
	minimal: 'Minimal thinking',
	low: 'Short thinking',
	medium: 'Moderate thinking',
	high: 'Long thinking: slower, pricier',
	xhigh: 'Maximum thinking: much slower and pricier'
};

/** What the chip's tooltip says. Every level costs time and jetons. */
export const reasoningHint = (effort: ReasoningEffort): string => HINTS[effort];

/**
 * Is `model` one the catalogue says thinks?
 *
 * `/api/model/options` carries a per-provider `capabilities` map
 * (`{model: {fast, reasoning}}`), built by `_apply_capabilities` in
 * `hermes_cli/inventory.py` from the models.dev catalogue. Upstream defaults
 * that flag to `true` for a model it does not recognise, on the grounds that
 * hiding the dial from a capable-but-uncatalogued model is the worse failure —
 * so this does the same, and only a model explicitly catalogued as
 * non-reasoning loses the dial.
 *
 * Measured on this Pi: all 81 servable models report `reasoning: true`, so this
 * hides nothing today. It is here so the app stops *promising* a dial the day a
 * catalogued non-reasoning model appears.
 */
export function modelDoesReasoning(options: ModelOptions | null, model: string): boolean {
	if (!options || !model) return true;
	for (const provider of options.providers) {
		const caps = provider.capabilities?.[model];
		if (caps && typeof caps.reasoning === 'boolean') return caps.reasoning;
	}
	return true;
}
