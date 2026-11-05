<script lang="ts">
	import { modelEntries, pickModels, priceDetail, priceLabel, shortModelName } from '$lib/models';
	import { chat } from '$lib/stores/chat.svelte';
	import MenuChip from './MenuChip.svelte';
	import {
		DEFAULT_REASONING,
		REASONING_EFFORTS,
		reasoningHint,
		reasoningLabel
	} from '$lib/reasoning';

	/** How many rows the menu will build at once. See `pickModels`. */
	const LIMIT = 100;

	let filter = $state('');

	let entries = $derived(modelEntries(chat.models));
	let page = $derived(pickModels(entries, filter, LIMIT));
	let matches = $derived(page.shown);

	let short = $derived(shortModelName(chat.activeModel));
	/** Only shown when the conversation deviates from Hermes' own setting. */
	let effortBadge = $derived(
		chat.activeReasoning === DEFAULT_REASONING ? '' : reasoningLabel(chat.activeReasoning)
	);
	/** A gateway too old to expose POST /api/sessions/{id}/model still pins the
	 *  model at session creation: the choice only lands on the next discussion. */
	let deferred = $derived(Boolean(chat.sessionId) && !chat.canSwitchModel);
</script>

<MenuChip
	width={340}
	triggerWidth={230}
	label="Model: {chat.activeModel || 'none'}{effortBadge ? `, thinking ${effortBadge}` : ''}"
	title={chat.activeModel}
>
	{#snippet chip()}
		<span class="name">{short || 'model'}</span>
		{#if effortBadge}<span class="badge">{effortBadge}</span>{/if}
	{/snippet}

	{#snippet menu(close)}
		{#if deferred}
			<p class="hint">
				This gateway pins the model per conversation: this choice will apply to the next chat.
			</p>
		{:else if chat.sessionId}
			<p class="hint">The chosen model applies to this conversation from the next message.</p>
		{/if}
		{#if chat.canPickReasoning}
			<div class="effort" role="group" aria-label="Thinking effort">
				<p class="head">Thinking</p>
				<div class="chips">
					{#each REASONING_EFFORTS as effort (effort)}
						<button
							class="chip"
							class:on={effort === chat.activeReasoning}
							title={reasoningHint(effort)}
							aria-pressed={effort === chat.activeReasoning}
							onclick={() => chat.setReasoning(effort)}
						>
							{reasoningLabel(effort)}
						</button>
					{/each}
				</div>
			</div>
		{/if}
		<input bind:value={filter} placeholder="Filter…" type="search" />
		<div class="items">
			{#each matches as entry (entry.provider + entry.model)}
				{@const price = priceLabel(entry.price)}
				<button
					class:sel={entry.model === chat.activeModel}
					title={priceDetail(entry.price) ?? entry.model}
					onclick={() => {
						chat.setModel(entry.model);
						close(true);
					}}
				>
					<span class="m">{entry.model}</span>
					<span class="meta">
						{#if price}<span class="price" class:free={entry.free}>{price}</span>{/if}
						<span class="p">{entry.providerName}</span>
					</span>
				</button>
			{/each}
			{#if matches.length === 0}
				<p class="hint">No model available. Configure a provider with `hermes model`.</p>
			{/if}
		</div>
		{#if page.hidden}
			<p class="more">
				{page.hidden} more model{page.hidden > 1 ? 's' : ''} — refine the filter.
			</p>
		{/if}
	{/snippet}
</MenuChip>

<style>
	/* The id is what gives way when the badge appears: flex children do not
	   inherit the parent's ellipsis, so it owns its own. */
	.name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* Says the open conversation deviates from Hermes' configured effort. There
	   is no badge for `auto`: that is what every conversation starts on. */
	.badge {
		flex: 0 0 auto;
		padding: 1px 7px;
		font-size: 10.5px;
		color: var(--accent);
		background: var(--accent-soft);
		border-radius: var(--radius-pill);
	}
	.effort {
		margin-bottom: 8px;
	}
	.head {
		margin: 0 0 5px;
		padding: 0 4px;
		font-size: 11px;
		color: var(--text-faint);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.chip {
		padding: 5px 11px;
		font-size: 12px;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: var(--radius-pill);
	}
	.chip:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chip.on {
		color: var(--accent);
		background: var(--accent-soft);
	}
	input {
		width: 100%;
		padding: 9px 13px;
		margin-bottom: 6px;
		background: var(--bg-sunken);
		border: none;
		border-radius: var(--radius-pill);
		font-size: 13px;
	}
	.items {
		display: flex;
		flex-direction: column;
		max-height: 320px;
		overflow-y: auto;
	}
	/* Two lines: the id can be forty characters long, and squeezing a price
	   next to it on 340px left both unreadable. */
	.items button {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		/* `.items` is a flex column, so a row would otherwise shrink to the
		   44px floor the touch rule sets and clip its first line. */
		flex: none;
		gap: 2px;
		padding: 8px 12px;
		border-radius: var(--radius-card);
		text-align: left;
		font-size: 13px;
	}
	.meta {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 10px;
	}
	.price {
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.price.free {
		color: var(--ok);
	}
	.more {
		margin: 6px 0 0;
		padding: 6px 9px;
		font-size: 11.5px;
		color: var(--text-faint);
		text-align: center;
	}
	.items button:hover {
		background: var(--bg-hover);
	}
	.items button.sel {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.m {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.p {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-faint);
	}
	.hint {
		margin: 0 0 6px;
		padding: 6px 9px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: 10px;
	}
	/* Thumb-sized rows on a phone, like every other control of the app. A
	   mis-tap here changes the model of the open conversation. */
	@media (max-width: 820px) {
		input,
		.items button,
		.chip {
			min-height: 44px;
		}
		/* The sheet is anchored to the screen bottom, so the list gets its
		   height from the viewport rather than from the 320px dropdown cap. */
		.items {
			max-height: 52dvh;
		}
	}
</style>
