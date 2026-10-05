<script lang="ts">
	import { agents } from '$lib/stores/agents.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { agentBinding, agentColor, agentInitial, directReports } from '$lib/agents';
	import { menuKeydown } from '$lib/client/menu.svelte';

	interface Props {
		/** Opens the editor — the picker only picks. */
		onmanage: () => void;
	}
	let { onmanage }: Props = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLDivElement | null>(null);

	// Three answers, not two: a roster we failed to read must not be allowed to
	// say "this conversation has no agent" — the binding lives on the session
	// row and the persona is composed from it server-side on every turn.
	let binding = $derived(agentBinding(agents.items, chat.activeAgentId));
	let active = $derived(binding.kind === 'known' ? binding.agent : undefined);
	let reports = $derived(active ? directReports(agents.items, active) : []);

	/** What the trigger shows, and what a screen reader hears, per binding. */
	let label = $derived(
		binding.kind === 'known' ? binding.agent.name : binding.kind === 'unknown' ? binding.id : 'Agent'
	);
	let described = $derived(
		binding.kind === 'known'
			? `Agent : ${binding.agent.name}`
			: binding.kind === 'unknown'
				? `Agent : ${binding.id} — sa fiche n'a pas pu être lue`
				: 'Agent : aucun, prompt par défaut de Yadai'
	);

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
			// Opening is a retry: `ensureLoaded` returns early only once a read
			// has succeeded, so a roster that failed at boot is re-read here.
			if (open) void agents.ensureLoaded();
		}}
		aria-haspopup="true"
		aria-expanded={open}
		aria-label={described}
		title={described}
	>
		<span class="dot"></span>
		<span class="label">{label}</span>
		<span class="mini"
			>{binding.kind === 'known' ? agentInitial(binding.agent) : binding.kind === 'unknown' ? '?' : 'Agent'}</span
		>
		<span class="chev" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" onclick={() => close()}></div>
		<div class="menu" bind:this={menu}>
			<p class="hint">
				{#if chat.sessionId}
					L'agent choisi prend la main sur cette conversation dès le prochain message.
				{:else}
					L'agent choisi démarrera la prochaine discussion.
				{/if}
			</p>
			{#if agents.loadError}
				<!-- Above the list, never instead of it: the list may be partly
				     right, and an empty one is not the same claim as a failed read. -->
				<div class="read-failed">
					<p>
						L'équipe n'a pas pu être lue — cette liste est peut-être incomplète.
						{#if binding.kind === 'unknown'}
							Cette conversation tourne toujours comme « {binding.id} ».
						{/if}
					</p>
					<p class="why">{agents.loadError}</p>
					<button class="retry" onclick={() => void agents.reload()} disabled={agents.loading}>
						{agents.loading ? 'Lecture…' : 'Réessayer'}
					</button>
				</div>
			{/if}
			<div class="items">
				<button class:sel={!chat.activeAgentId} onclick={() => choose('')}>
					<span class="n">Sans agent</span>
					<span class="j">prompt par défaut de Yadai</span>
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
					{active?.name} peut déléguer à {reports.map((a) => a.name).join(', ')}.
				</p>
			{/if}
			<button class="manage" onclick={() => { close(); onmanage(); }}>Gérer l'équipe…</button>
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
	.mini {
		display: none;
	}
	.chev {
		font-size: 9px;
	}
	/* The header carries two pickers plus three icons; on a phone the agent
	   shrinks to its emoji so the conversation title keeps some room. */
	@media (max-width: 700px) {
		.trigger {
			padding: 7px 10px;
		}
		.label {
			display: none;
		}
		.mini {
			display: inline;
		}
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
	.read-failed {
		margin: 0 0 6px;
		padding: 7px 9px;
		border-radius: 10px;
		background: var(--danger-soft);
	}
	.read-failed p {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text);
	}
	.read-failed .why {
		margin-top: 3px;
		color: var(--text-muted);
		font-size: 11px;
	}
	.retry {
		margin-top: 5px;
		padding: 4px 11px;
		border-radius: 999px;
		background: var(--bg-raised);
		font-size: 12px;
	}
	.retry:disabled {
		opacity: 0.45;
		cursor: default;
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
		.manage,
		.retry {
			min-height: 44px;
		}
	}
</style>
