<script lang="ts">
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import PushSettings from './PushSettings.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { usageSummary } from '$lib/sessions';
	import { jobState, nextRunLabel, scheduleDisplay, sortJobs } from '$lib/jobs';
	import { formatBytes } from '$lib/format';
	import { machineLine, systemRows, type SystemRow } from '$lib/system';
	import type { IconName } from '$lib/icons';
	import type { HermesJob } from '$lib/types';

	interface Props {
		open: boolean;
		onclose: () => void;
		onopenJobs: () => void;
	}
	let { open, onclose, onopenJobs }: Props = $props();

	let jobs = $derived(sortJobs(chat.status?.jobs ?? []));

	/**
	 * Schedule plus next run, as one string.
	 *
	 * `job.schedule` is an object upstream, so it can never be printed
	 * directly; and building this inline would let Svelte trim the leading
	 * space of the conditional half and glue the two together.
	 */
	function jobLine(job: HermesJob): string {
		const next = jobState(job).key === 'paused' ? '' : nextRunLabel(job);
		return next ? `${scheduleDisplay(job)} · ${next}` : scheduleDisplay(job);
	}

	// Refresh on open only: /health/detailed stats the disk and reads the
	// gateway runtime file, which is not something to poll on a Pi.
	$effect(() => {
		if (open) chat.refreshStatus();
	});

	let health = $derived(chat.status?.health ?? null);
	let checks = $derived(Object.entries(health?.readiness?.checks ?? {}));

	/* The Pi itself. Four numbers the gateway does not report, which used to
	   cost an agent turn and a `terminal` call to obtain — see $lib/system for
	   why disk is not among them, and why a missing field draws no row. */
	let machine = $derived(systemRows(chat.status?.system));
	/* Keyed by the union, so a new row cannot ship without its icon — the type
	   is what guards this, since the icon scan only reads `name="…"`. */
	const SYSTEM_ICONS: Record<SystemRow['key'], IconName> = {
		cpu: 'cpu',
		load: 'gauge',
		memory: 'memory',
		uptime: 'clock'
	};

	/* A coloured dot, not a coloured emoji: the emoji circles came from the
	   platform's font, so "healthy" was a different green on the phone than on
	   the desktop and neither belonged to the palette. */
	function level(status: string): 'ok' | 'warn' | 'ko' {
		if (status === 'ok') return 'ok';
		if (status === 'warn' || status === 'degraded') return 'warn';
		return 'ko';
	}

	const LABELS: Record<string, string> = {
		state_db: 'Base de données',
		config: 'Configuration',
		model: 'Modèle',
		disk: 'Disque',
		gateway: 'Gateway',
		background_queues: "Files d'arrière-plan"
	};

	/** Pull the interesting numbers out of a readiness check for display. */
	function detail(name: string, check: Record<string, unknown>): string {
		if (name === 'disk') {
			const used = check.used_percent as number | undefined;
			// `formatBytes`, not a hand-rolled division by 1024³: the memory row
			// three lines down already uses it, and rounding to whole gigabytes
			// printed "0 Go libres" for a card with 400 Mo left.
			const bytes = check.free_bytes;
			const free =
				typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
					? formatBytes(bytes)
					: null;
			return [used !== undefined ? `${used}% utilisé` : null, free ? `${free} libres` : null]
				.filter(Boolean)
				.join(' · ');
		}
		if (name === 'gateway') {
			return `${check.state ?? '?'} · ${check.connected_platforms ?? 0}/${check.platforms ?? 0} plateformes`;
		}
		if (name === 'background_queues') {
			return `${check.active_api_runs ?? 0} run(s) API · ${check.active_delegations ?? 0} délégation(s)`;
		}
		return '';
	}
</script>

<Modal {open} title="État du système" width={560} {onclose}>
	<div class="body">
		{#if chat.status === null}
			<p class="muted">Chargement…</p>
		{:else if chat.status.healthError}
			<p class="err"><Icon name="warning" size={15} /> {chat.status.healthError}</p>
		{/if}

		{#if health}
			<div class="hero">
				<span class="dot big {level(health.readiness?.status ?? health.status)}"></span>
				<div>
					<div class="strong">Yadai {health.version}</div>
					<div class="muted">
						gateway {health.gateway_state ?? '?'} · PID {health.pid}
						{#if health.gateway_busy}· occupé{/if}
					</div>
				</div>
			</div>

			<h3>Contrôles</h3>
			<ul class="checks">
				{#each checks as [name, check] (name)}
					<li>
						<span class="dot {level(String(check.status))}"></span>
						<span class="name">{LABELS[name] ?? name}</span>
						<span class="muted small">{detail(name, check)}</span>
					</li>
				{/each}
			</ul>

			<h3>Plateformes</h3>
			<ul class="checks">
				{#each Object.entries(health.platforms ?? {}) as [name, info] (name)}
					<li>
						<span class="dot {info.state === 'connected' ? 'ok' : 'ko'}"></span>
						<span class="name">{name}</span>
						<span class="muted small">{info.state ?? '?'}{info.error_code ? ` · ${info.error_code}` : ''}</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if machine.length > 0 || chat.status?.systemError}
			<h3>Le Raspberry Pi</h3>
			{#if machine.length > 0}
				{#if machineLine(chat.status?.system)}
					<p class="muted small machine">{machineLine(chat.status?.system)}</p>
				{/if}
				<ul class="checks">
					{#each machine as row (row.key)}
						<li>
							<span class="li-icon"><Icon name={SYSTEM_ICONS[row.key]} size={15} /></span>
							<span class="name">{row.label}</span>
							<span class="value {row.level}">{row.value}</span>
							{#if row.detail}<span class="muted small">{row.detail}</span>{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted small machine">{chat.status?.systemError}</p>
			{/if}
		{/if}

		<h3>Cette interface</h3>
		<ul class="checks">
			<li>
				<span class="li-icon"><Icon name="settings" size={15} /></span>
				<span class="name">Tours simultanés</span>
				<span class="muted small">
					{chat.status?.turns.active ?? 0} / {chat.status?.turns.limit ?? '—'}
				</span>
			</li>
			<li>
				<span class="li-icon"><Icon name="wrench" size={15} /></span>
				<span class="name">Outils exposés</span>
				<span class="muted small">
					{chat.toolCount}{chat.mcpTools.length ? ` · dont ${chat.mcpTools.length} MCP` : ''}
				</span>
			</li>
			<li>
				<span class="li-icon"><Icon name="book" size={15} /></span>
				<span class="name">Skills</span>
				<span class="muted small">{chat.skills.length}</span>
			</li>
			{#if usageSummary(chat.current)}
				<li>
					<span class="li-icon"><Icon name="chart" size={15} /></span>
					<span class="name">Conversation ouverte</span>
					<span class="muted small">{usageSummary(chat.current)}</span>
				</li>
			{/if}
		</ul>

		<PushSettings />

		{#if chat.status?.jobsAvailable}
			<h3>
				Tâches planifiées
				<button class="link" onclick={onopenJobs}>gérer</button>
			</h3>
			{#if jobs.length === 0}
				<p class="muted small empty">Aucune tâche planifiée.</p>
			{:else}
				<ul class="checks">
					{#each jobs as job (job.id ?? job.name)}
						{@const state = jobState(job)}
						<li>
							<span class="li-icon" title={state.label}><Icon name={state.icon} size={15} /></span>
							<span class="name">{job.name ?? job.id}</span>
							<span class="muted small">{jobLine(job)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		{#if chat.mcpTools.length}
			<h3>Outils MCP</h3>
			<p class="tools">
				{#each chat.mcpTools as tool (tool)}<code>{tool}</code>{/each}
			</p>
		{/if}
	</div>

	{#snippet footer()}
		<button class="refresh" onclick={() => chat.refreshStatus()}>Actualiser</button>
	{/snippet}
</Modal>

<style>
	/* One dot, three states, all three from the palette — see `level()`. */
	.dot {
		flex: 0 0 auto;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	.dot.big {
		width: 13px;
		height: 13px;
	}
	.dot.ok {
		background: var(--ok);
	}
	.dot.warn {
		background: var(--accent);
	}
	.dot.ko {
		background: var(--danger);
	}
	.li-icon {
		display: flex;
		color: var(--text-faint);
	}

	h3 {
		margin: 18px 0 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	h3:first-of-type {
		margin-top: 14px;
	}
	h3 .link {
		margin-left: 8px;
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: var(--text-muted);
		text-decoration: underline;
	}
	h3 .link:hover {
		color: var(--text);
	}
	.empty {
		margin: 0;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 4px 16px 16px;
	}
	.hero {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 0 2px;
	}
	.big {
		font-size: 22px;
	}
	.strong {
		font-weight: 600;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 12px;
	}
	.err {
		padding: 8px 11px;
		border-radius: 8px;
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 13px;
	}
	.checks {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.checks li {
		display: flex;
		align-items: baseline;
		gap: 9px;
		padding: 5px 8px;
		border-radius: 7px;
		font-size: 13.5px;
	}
	.checks li:nth-child(odd) {
		background: var(--bg-sunken);
	}
	.name {
		flex: 1;
		min-width: 0;
	}
	/* The number carries the verdict here, rather than a dot: a percentage is
	   already the reading, and a dot beside it would say the same thing twice. */
	.value {
		font-variant-numeric: tabular-nums;
	}
	.value.warn {
		color: var(--accent);
	}
	.value.ko {
		color: var(--danger);
	}
	.machine {
		margin: 0 0 4px;
		padding: 0 8px;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin: 0;
	}
	.tools code {
		padding: 2px 7px;
		font-size: 11.5px;
		background: var(--bg-sunken);
		border-radius: 5px;
		color: var(--text-muted);
	}
	.refresh {
		margin-left: auto;
		padding: 5px 12px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 13px;
	}
	.refresh:hover {
		background: var(--bg-hover);
	}
</style>
