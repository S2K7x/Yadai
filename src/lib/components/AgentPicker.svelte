<script lang="ts">
	import { agents } from '$lib/stores/agents.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { agentColor, directReports } from '$lib/agents';
	import { menuKeydown } from '$lib/client/menu.svelte';

	interface Props {
		/** Opens the editor — the picker only picks. */
		onmanage: () => void;
	}
	let { onmanage }: Props = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);

	let active = $derived(agents.byId(chat.activeAgentId));
	let reports = $derived(active ? directReports(agents.items, active) : []);

	/** Escape hands the focus back to the button the list came from. */
	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}

	function choose(id: string) {
		chat.setAgent(id);
		close(true);
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
		style="--agent: {active ? agentColor(active) : 'var(--text-faint)'}"
		onclick={(event) => {
			// Safari does not focus a clicked button; without this, Escape would
			// be typed at <body> and reach the page handler, where it means
			// "close the drawer" or "detach the running turn".
			event.currentTarget.focus();
			open = !open;
		}}
		aria-haspopup="true"
		aria-expanded={open}
		aria-label={active ? `Agent: ${active.name}` : "Agent: none, Yadai's default prompt"}
		title={active ? `Agent: ${active.name}` : "No agent — Yadai's default prompt"}
	>
		<span class="dot"></span>
		<span class="label">{active ? active.name : 'Agent'}</span>
		<span class="chev" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" onclick={() => close()}></div>
		<div class="menu" bind:this={menu}>
			<p class="hint">
				{#if chat.sessionId}
					The chosen agent takes over this conversation from the next message.
				{:else}
					The chosen agent will start the next chat.
				{/if}
			</p>
			<div class="items">
				<button class:sel={!chat.activeAgentId} onclick={() => choose('')}>
					<span class="n">No agent</span>
					<span class="j">Yadai's default prompt</span>
				</button>
				{#each agents.items as agent (agent.id)}
					<button
						class:sel={agent.id === chat.activeAgentId}
						style="--agent: {agentColor(agent)}"
						onclick={() => choose(agent.id)}
					>
						<span class="n"><span class="dot"></span>{agent.name}</span>
						{#if agent.role}<span class="j">{agent.role}</span>{/if}
					</button>
				{/each}
			</div>
			{#if reports.length > 0}
				<p class="hint team">
					{active?.name} can delegate to {reports.map((a) => a.name).join(', ')}.
				</p>
			{/if}
			<button class="manage" onclick={() => { close(); onmanage(); }}>Manage team…</button>
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
		max-width: 170px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.trigger:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--agent);
		margin-right: 2px;
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chev {
		font-size: 9px;
	}
	/* The phone header gives the pickers a row of their own, so the agent
	   keeps its name there instead of shrinking to an initial. */
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
		width: min(320px, 88vw);
		padding: 9px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
	}
	.items {
		display: flex;
		flex-direction: column;
		max-height: 320px;
		overflow-y: auto;
	}
	.items button {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 9px 12px;
		border-radius: var(--radius-card);
		text-align: left;
		font-size: 13px;
	}
	.items button:hover {
		background: var(--bg-hover);
	}
	.items button.sel {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.n {
		display: flex;
		align-items: center;
		gap: 5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.j {
		font-size: 11px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	.hint.team {
		margin: 6px 0 0;
	}
	.manage {
		width: 100%;
		margin-top: 6px;
		padding: 6px 9px;
		margin-top: 4px;
		font-size: 12.5px;
		color: var(--text-muted);
		text-align: left;
	}
	.manage:hover {
		color: var(--text);
	}
	/* Thumb-sized rows on a phone, like every other control of the app. */
	@media (max-width: 820px) {
		.items button,
		.manage {
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
