<script lang="ts">
	import { agents } from '$lib/stores/agents.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { agentChipState, agentColor, directReports } from '$lib/agents';
	import MenuChip from './MenuChip.svelte';

	interface Props {
		/** Opens the editor — the picker only picks. */
		onmanage: () => void;
	}
	let { onmanage }: Props = $props();

	let active = $derived(agents.byId(chat.activeAgentId));
	let reports = $derived(active ? directReports(agents.items, active) : []);
	/**
	 * Three answers, not two — see `agentChipState`.
	 *
	 * A roster that failed to load used to make this chip say "no agent" about a
	 * conversation that had one, and leave a menu whose only entry was
	 * "No agent" — one tap from detaching the persona for real. So when the
	 * roster is not readable the menu offers to read it again instead of
	 * offering a choice made out of nothing.
	 */
	let chipState = $derived(agentChipState(agents.state, chat.activeAgentId, active));
	let unreadable = $derived(agents.state !== 'ready');
	let dot = $derived(
		active && chipState === 'named'
			? agentColor(active)
			: chipState === 'unknown'
				? 'var(--accent)'
				: 'var(--text-faint)'
	);
</script>

<MenuChip
	width={320}
	triggerWidth={170}
	label={chipState === 'named'
		? `Agent: ${active?.name}`
		: chipState === 'unknown'
			? 'Agent: set, but the team could not be read'
			: "Agent: none, Yadai's default prompt"}
	title={chipState === 'named'
		? `Agent: ${active?.name}`
		: chipState === 'unknown'
			? 'This chat has an agent, but the team could not be read.'
			: "No agent — Yadai's default prompt"}
>
	{#snippet chip()}
		<span class="dot" style="--agent: {dot}" aria-hidden="true"></span>
		<span class="label">{chipState === 'named' ? active?.name : 'Agent'}</span>
		{#if chipState === 'unknown'}<span class="unknown" aria-hidden="true">?</span>{/if}
	{/snippet}

	{#snippet menu(close)}
		{#if unreadable}
			<!-- No list and no "No agent" entry: both would be a choice composed
			     on a roster we do not have, and the second one writes a real
			     detachment upstream. -->
			<p class="hint">
				{agents.loadError ?? 'Reading the team…'}
			</p>
			<button
				class="manage retry"
				disabled={agents.loading}
				onclick={() => {
					void agents.reload();
				}}>{agents.loading ? 'Reading…' : 'Retry'}</button
			>
		{:else}
			<p class="hint">
				{#if chat.sessionId}
					The chosen agent takes over this conversation from the next message.
				{:else}
					The chosen agent will start the next chat.
				{/if}
			</p>
			<div class="items">
				<button
					class:sel={!chat.activeAgentId}
					onclick={() => {
						chat.setAgent('');
						close(true);
					}}
				>
					<span class="n">No agent</span>
					<span class="j">Yadai's default prompt</span>
				</button>
				{#each agents.items as agent (agent.id)}
					<button
						class:sel={agent.id === chat.activeAgentId}
						onclick={() => {
							chat.setAgent(agent.id);
							close(true);
						}}
					>
						<span class="n"
							><span class="dot" style="--agent: {agentColor(agent)}"></span>{agent.name}</span
						>
						{#if agent.role}<span class="j">{agent.role}</span>{/if}
					</button>
				{/each}
			</div>
			{#if reports.length > 0}
				<p class="hint team">
					{active?.name} can delegate to {reports.map((a) => a.name).join(', ')}.
				</p>
			{/if}
		{/if}
		<button
			class="manage"
			onclick={() => {
				close();
				onmanage();
			}}>Manage team…</button
		>
	{/snippet}
</MenuChip>

<style>
	.dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--agent);
		margin-right: 2px;
	}
	/* The phone header gives the pickers a row of their own, so the agent
	   keeps its name there instead of shrinking to an initial. */
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The chip carries an agent it cannot name: better a mark than a lie. */
	.unknown {
		flex: 0 0 auto;
		color: var(--accent);
		font-weight: 600;
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
		/* `.items` is a flex column, so a two-line row would otherwise shrink
		   to the 44px floor the touch rule sets and clip its first line. */
		flex: none;
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
		margin-top: 4px;
		padding: 6px 9px;
		font-size: 12.5px;
		color: var(--text-muted);
		text-align: left;
	}
	.manage:hover {
		color: var(--text);
	}
	.retry {
		margin-top: 0;
		color: var(--text);
		text-align: center;
		background: var(--bg-sunken);
		border-radius: 999px;
	}
	.retry:disabled {
		opacity: 0.45;
		cursor: default;
	}
	/* Thumb-sized rows on a phone, like every other control of the app. */
	@media (max-width: 820px) {
		.items button,
		.manage {
			min-height: 44px;
		}
		/* The sheet is anchored to the screen bottom, so the list gets its
		   height from the viewport rather than from the 320px dropdown cap. */
		.items {
			max-height: 52dvh;
		}
	}
</style>
