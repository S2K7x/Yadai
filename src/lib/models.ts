/** Pure helpers over the `/api/model/options` inventory. */

import { includesFolded, searchNeedle } from './text.ts';
import type { ModelOptions, ModelPrice } from './types';

/** Last path segment — "openrouter/deepseek/free" reads as "free" in a pill. */
export function shortModelName(model: string): string {
	return model.split('/').at(-1) || model;
}

/**
 * Which provider serves `model`, as a slug Hermes accepts in a model lock.
 *
 * Hermes routes a lock request by (provider, model); sending the provider
 * removes the ambiguity when the same model id is offered by two providers
 * (a local Ollama copy and a hosted one, say). Providers without credentials
 * are skipped: locking onto one guarantees a failed turn.
 *
 * Returns '' when the model is unknown or only offered by unauthenticated
 * providers — the caller then sends the model alone and lets Hermes route it.
 */
export function providerForModel(options: ModelOptions | null, model: string): string {
	if (!options || !model) return '';
	const usable = options.providers.filter((p) => p.authenticated && p.models.includes(model));
	if (usable.length === 0) return '';
	// The provider already in use wins, so switching model inside a provider
	// does not silently migrate the conversation to another one.
	return (usable.find((p) => p.is_current) ?? usable[0]).slug;
}

/**
 * Is `model` still offered by an authenticated provider?
 *
 * A model saved in localStorage can outlive the credentials that served it.
 */
export function isModelAvailable(options: ModelOptions | null, model: string): boolean {
	if (!options || !model) return false;
	return options.providers.some((p) => p.authenticated && p.models.includes(model));
}

// ---------------------------------------------------------------------------
// The picker list
// ---------------------------------------------------------------------------

/** One selectable line of the model menu. */
export interface ModelEntry {
	/** Provider slug, as Hermes accepts it in a model lock. */
	provider: string;
	providerName: string;
	model: string;
	/** What a million tokens costs, when the catalogue says. */
	price: ModelPrice | null;
	free: boolean;
}

/**
 * Every model a turn could actually run on, in the order Hermes listed them.
 *
 * Two exclusions, both of which would otherwise pin an unusable model on a
 * session row and fail *every* turn afterwards (CLAUDE.md §1):
 *
 * - providers without credentials, which is what the picker already did;
 * - `unavailable_models`, the paid models a Nous free-tier account cannot
 *   pick. Upstream builds that list in `_apply_pricing` and leaves it empty
 *   whenever the tier check does not apply or fails, so honouring it can only
 *   ever remove a model the account was going to be refused anyway.
 */
export function modelEntries(options: ModelOptions | null): ModelEntry[] {
	const out: ModelEntry[] = [];
	for (const p of options?.providers ?? []) {
		if (!p.authenticated || !p.models?.length) continue;
		const blocked = new Set(Array.isArray(p.unavailable_models) ? p.unavailable_models : []);
		for (const model of p.models) {
			if (blocked.has(model)) continue;
			const price = p.pricing?.[model] ?? null;
			out.push({
				provider: p.slug,
				providerName: p.name,
				model,
				price,
				free: price?.free === true
			});
		}
	}
	return out;
}

/**
 * The line shown under a model id, or null when nothing is known.
 *
 * The figures come formatted from upstream — this only decides what a missing
 * half means. Never guesses: a row whose provider has no catalogue simply says
 * nothing, rather than implying the model is free.
 */
export function priceLabel(price: ModelPrice | null | undefined): string | null {
	if (!price) return null;
	if (price.free) return 'Free';
	const parts = [price.input, price.output].filter((v): v is string => Boolean(v) && v !== 'free');
	if (parts.length === 0) return null;
	return `${parts.join(' / ')} per Mtok`;
}

/** The same figures spelled out, for the row's tooltip. */
export function priceDetail(price: ModelPrice | null | undefined): string | null {
	if (!price) return null;
	if (price.free) return 'Free, per million tokens';
	const parts: string[] = [];
	if (price.input) parts.push(`Input ${price.input}`);
	if (price.output) parts.push(`Output ${price.output}`);
	if (price.cache) parts.push(`Cache ${price.cache}`);
	if (parts.length === 0) return null;
	return `${parts.join(' · ')}, per million tokens`;
}

/**
 * Filter and cap the menu, saying how many rows the cap hid.
 *
 * The cap is what keeps a provider with three hundred models from building
 * three hundred DOM nodes on a Pi the moment the menu opens. What it must not
 * do is drop them in silence: the previous `.slice(0, 60)` left twenty of this
 * machine's eighty models unreachable unless the user happened to type a
 * filter that matched them, with nothing on screen to suggest they existed.
 *
 * The query matches the provider too — its name is drawn on every row, so
 * typing what is written there has to work.
 */
export function pickModels(
	entries: ModelEntry[],
	query: string,
	limit: number
): { shown: ModelEntry[]; hidden: number } {
	const needle = searchNeedle(query);
	const matched = needle
		? entries.filter(
				(e) =>
					includesFolded(e.model, needle) ||
					includesFolded(e.providerName, needle) ||
					includesFolded(e.provider, needle)
			)
		: entries;
	return { shown: matched.slice(0, limit), hidden: Math.max(0, matched.length - limit) };
}
