<script lang="ts">
	import { untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import { usage } from '$lib/stores/usage.svelte';
	import { shouldLoadPanel } from '$lib/availability';
	import { formatCount, formatTokens } from '$lib/format';
	import {
		USAGE_PERIODS,
		dailyBars,
		modelDetail,
		hasUsage,
		costNote,
		modelShares,
		periodLabel,
		toolShares,
		usageTiles,
		type UsagePeriod
	} from '$lib/usage';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	/**
	 * Read once per opening, and again after a failure.
	 *
	 * `open` is the only dependency on purpose: `state` is read through
	 * `untrack` because `failed` is a state that asks to be reloaded, and an
	 * effect that re-ran on every store mutation would call `load()`, watch it
	 * fail, and call it again — a tight loop against the endpoint that just
	 * went down.
	 */
	$effect(() => {
		if (!open) return;
		if (untrack(() => shouldLoadPanel(usage.state, usage.loading))) void usage.load();
	});

	let report = $derived(usage.report);
	let bars = $derived(report ? dailyBars(report) : []);
	let tiles = $derived(report ? usageTiles(report) : []);
	let models = $derived(report ? modelShares(report) : []);
	let tools = $derived(report ? toolShares(report) : []);
	let note = $derived(report ? costNote(report) : null);
	let measured = $derived(!!report && hasUsage(report));

	/**
	 * Label every bar on a week, one in five on a month, one in ten beyond.
	 *
	 * Ninety labels under ninety bars is a grey smear; the date each bar means
	 * is on its tooltip either way.
	 */
	let labelEvery = $derived(bars.length <= 10 ? 1 : bars.length <= 35 ? 5 : 10);
	const labelled = (index: number, length: number, every: number) =>
		index === length - 1 || (length - 1 - index) % every === 0;

	function pick(period: UsagePeriod) {
		if (period !== usage.period) void usage.setPeriod(period);
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Modal {open} title="Consommation" width={580} {onclose}>
	{#snippet subtitle()}Ce que l'agent a consommé, toutes surfaces confondues{/snippet}
	<div class="body">
		<div class="periods" role="group" aria-label="Période">
			{#each USAGE_PERIODS as period (period)}
				<button
					class="period"
					class:sel={usage.period === period}
					aria-pressed={usage.period === period}
					onclick={() => pick(period)}
				>
					{periodLabel(period)}
				</button>
			{/each}
			<button
				class="reload"
				disabled={usage.loading}
				onclick={() => usage.refresh()}
				aria-label="Actualiser"
			>
				<Icon name="restore" size={15} />
			</button>
		</div>

		{#if usage.state === 'failed'}
			<p class="fail">{usage.loadError}</p>
			<button class="retry" onclick={() => usage.load()}>Réessayer</button>
			<p class="lead">
				Ce chiffre vient du dashboard de Hermes. Un échec de lecture ne dit rien de sa
				configuration : il est peut-être simplement redémarré.
			</p>
		{:else if usage.state === 'disabled'}
			<p class="fail">{usage.message}</p>
		{:else if usage.state === 'unread'}
			<p class="lead">Lecture…</p>
		{:else if !measured}
			<p class="lead">
				Rien de mesuré sur les {periodLabel(usage.period)}. Hermes ne compte une session
				qu'une fois un appel au modèle effectué.
			</p>
		{:else if report}
			<div class="tiles">
				{#each tiles as tile (tile.key)}
					<div class="tile">
						<span class="t-label">{tile.label}</span>
						<span class="t-value">{tile.value}</span>
						<span class="t-detail">{tile.detail}</span>
					</div>
				{/each}
			</div>
			{#if note}
				<p class="lead">{note}</p>
			{/if}

			<h3>Par jour</h3>
			<div class="chart" aria-hidden="true">
				{#each bars as bar (bar.day)}
					<div class="col" title="{bar.label} — {formatTokens(bar.tokens)} tokens">
						<div class="bar" style="height: {Math.max(bar.share * 100, bar.tokens > 0 ? 3 : 1)}%"
							class:empty={bar.tokens === 0}></div>
					</div>
				{/each}
			</div>
			<div class="axis" aria-hidden="true">
				{#each bars as bar, index (bar.day)}
					<span class="tick">
						{labelled(index, bars.length, labelEvery) ? bar.label : ''}
					</span>
				{/each}
			</div>
			<!-- The chart is decorative; this is the same data, read out. -->
			<p class="sr-only">
				{bars.length} journées, du {bars[0]?.label} au {bars[bars.length - 1]?.label}.
				{#each bars.filter((b) => b.tokens > 0) as bar (bar.day)}
					{bar.label} : {formatTokens(bar.tokens)} tokens.
				{/each}
			</p>
			<p class="lead small">
				Hermes découpe ces journées en <strong>UTC</strong>, pas à votre heure locale.
			</p>

			<h3>Par modèle</h3>
			<ul class="rows">
				{#each models as row (row.item.model)}
					<li>
						<span class="r-top">
							<span class="r-name">{row.item.model}</span>
							<span class="r-value">{formatTokens(row.item.inputTokens + row.item.outputTokens)}</span>
						</span>
						<span class="track"><span class="fill" style="width: {row.share * 100}%"></span></span>
						{#if modelDetail(row.item)}
							<span class="r-foot">{modelDetail(row.item)}</span>
						{/if}
					</li>
				{:else}
					<li class="none">Aucun modèle sur cette période.</li>
				{/each}
			</ul>

			{#if tools.length > 0}
				<h3>Outils les plus appelés</h3>
				<ul class="rows">
					{#each tools as row (row.item.tool)}
						<li>
							<span class="r-top">
								<span class="r-name mono">{row.item.tool}</span>
								<span class="r-value">{formatCount(row.item.count)}</span>
							</span>
							<span class="track"
								><span class="fill alt" style="width: {row.share * 100}%"></span></span
							>
						</li>
					{/each}
				</ul>
			{/if}

			{#if report.skills.length > 0}
				<h3>Skills chargés</h3>
				<ul class="chips">
					{#each report.skills as skill (skill.skill)}
						<li>{skill.skill} <span class="muted">{formatCount(skill.count)}</span></li>
					{/each}
				</ul>
			{/if}

			<p class="lead foot">
				Ces chiffres couvrent <strong>tout</strong> ce que l'agent a fait : cette interface, le
				CLI, Telegram et les tâches planifiées. Une « session » est une session Hermes — une
				conversation compressée en occupe plusieurs.
			</p>
		{/if}
	</div>
</Modal>

<style>
	.body {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 4px 16px 18px;
	}
	h3 {
		margin: 22px 0 8px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.lead {
		margin: 10px 0 0;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-faint);
	}
	.lead.small {
		font-size: 11.5px;
	}
	.foot {
		margin-top: 22px;
	}
	.fail {
		margin: 12px 0 6px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--danger);
	}
	.retry {
		font-size: 13px;
		color: var(--accent);
	}
	.muted {
		color: var(--text-faint);
	}

	/* Period picker */
	.periods {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 0 2px;
	}
	.period {
		min-height: 36px;
		padding: 7px 14px;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		font-size: 13px;
		font-weight: 600;
		color: var(--text-muted);
	}
	.period:hover {
		background: var(--bg-hover);
	}
	.period.sel {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.reload {
		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		color: var(--text-faint);
	}
	.reload:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.reload:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* Tiles */
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--gap-card);
		margin-top: 12px;
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 11px 14px;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
	}
	.t-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.t-value {
		font-size: 20px;
		font-weight: 600;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.t-detail {
		font-size: 11.5px;
		color: var(--text-faint);
		min-height: 15px;
	}

	/* Daily bars */
	.chart {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 110px;
		padding: 0 2px;
	}
	.col {
		flex: 1;
		min-width: 0;
		height: 100%;
		display: flex;
		align-items: flex-end;
	}
	.bar {
		width: 100%;
		min-height: 2px;
		border-radius: 3px 3px 1px 1px;
		background: var(--accent);
	}
	.bar.empty {
		background: var(--bg-hover);
	}
	.axis {
		display: flex;
		gap: 2px;
		padding: 5px 2px 0;
	}
	.tick {
		flex: 1;
		min-width: 0;
		font-size: 10px;
		color: var(--text-faint);
		text-align: center;
		white-space: nowrap;
		overflow: visible;
	}

	/* Model / tool rows */
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--gap-card);
	}
	.rows li {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 10px 13px;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
	}
	.r-top {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.r-name {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mono {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 12px;
	}
	.r-value {
		flex: 0 0 auto;
		font-size: 13px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.r-foot {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.track {
		display: block;
		height: 5px;
		border-radius: 3px;
		background: var(--bg-hover);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: 3px;
		background: var(--accent);
	}
	.fill.alt {
		background: var(--accent-2);
	}
	.none {
		color: var(--text-faint);
		font-size: 12.5px;
	}

	/* Skills */
	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chips li {
		padding: 5px 11px;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		font-size: 12px;
		color: var(--text-muted);
	}

	@media (max-width: 820px) {
		.period {
			min-height: 44px;
		}
		.reload {
			width: 44px;
			height: 44px;
		}
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
