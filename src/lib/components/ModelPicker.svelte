<script lang="ts">
	import { modelEntries, pickModels, priceDetail, priceLabel, shortModelName } from '$lib/models';
	import { chat } from '$lib/stores/chat.svelte';
	import { menuKeydown } from '$lib/client/menu.svelte';
	import {
		DEFAULT_REASONING,
		REASONING_EFFORTS,
		reasoningHint,
		reasoningLabel
	} from '$lib/reasoning';

	/** How many rows the menu will build at once. See `pickModels`. */
	const LIMIT = 100;

	let open = $state(false);
	let filter = $state('');
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);

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

	/** Escape hands the focus back to the button the list came from. */
	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="picker"
	onkeydown={(event) => {
		if (open && menuKeydown(menu, event) === 'close') close(true);
	}}
>
	<button
		class="trigger"
		bind:this={trigger}
		onclick={(event) => {
			// Safari does not focus a clicked button; without this, Escape would
			// be typed at <body> and reach the page handler, where it means
			// "close the drawer" or "detach the running turn".
			event.currentTarget.focus();
			open = !open;
		}}
		aria-haspopup="true"
		aria-expanded={open}
		aria-label="Model: {chat.activeModel || 'none'}{effortBadge
			? `, thinking ${effortBadge}`
			: ''}"
		title={chat.activeModel}
	>
		<span class="name">{short || 'model'}</span>
		{#if effortBadge}<span class="badge">{effortBadge}</span>{/if}
		<span class="chev" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" onclick={() => close()}></div>
		<div class="menu" bind:this={menu}>
			{#if deferred}
				<p class="hint">
					This gateway pins the model per conversation: this choice will apply to the next
					chat.
				</p>
			{:else if chat.sessionId}
				<p class="hint">
					The chosen model applies to this conversation from the next message.
				</p>
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
		</div>
	{/if}
</div>

<style>
	.picker {
		position: relative;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 7px 13px;
		font-size: 12.5px;
		color: var(--text-muted);
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		border-radius: var(--radius-pill);
		/* Room for the effort badge without the model id losing more than it
		   already ellipsises away. */
		max-width: 230px;
		overflow: hidden;
		white-space: nowrap;
	}
	/* The id is what gives way when the badge appears: flex children do not
	   inherit the parent's ellipsis, so it owns its own. */
	.name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.trigger:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chev {
		font-size: 9px;
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
	/* Touch: a header control is as much a target as any other, and these two
	   were measured at 34px tall on a phone. */
	@media (max-width: 820px) {
		.trigger {
			min-height: 44px;
		}
		.items button {
			min-height: 44px;
		}
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 30;
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 31;
		width: min(340px, 88vw);
		padding: 9px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
	}
	.menu input {
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
		.menu input,
		.items button,
		.chip {
			min-height: 44px;
		}
	}
	/* Phone: a bottom sheet, not a dropdown. The chip sits on the header's
	   second row, wherever the title left it; a sheet is anchored to the
	   screen instead, within reach of a thumb, and wide enough for a model
	   id and its price. */
	@media (max-width: 820px) {
		.scrim {
			background: var(--scrim);
		}
		.menu {
			position: fixed;
			left: 8px;
			right: 8px;
			top: auto;
			bottom: calc(8px + env(safe-area-inset-bottom));
			width: auto;
			padding: 12px;
		}
		.items {
			max-height: 52dvh;
		}
	}
</style>
