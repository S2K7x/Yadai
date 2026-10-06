<script lang="ts">
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import type { IconName } from '$lib/icons';

	interface Props {
		open: boolean;
		onclose: () => void;
		onopenStatus: () => void;
		onopenSkills: () => void;
		onopenProviders: () => void;
		onopenJobs: () => void;
		onopenAgents: () => void;
		onopenTheme: () => void;
		onopenShortcuts: () => void;
		onopenApprovals: () => void;
		onopenUsage: () => void;
		onshowArchived: () => void;
		onshowTrash: () => void;
	}
	let {
		open,
		onclose,
		onopenStatus,
		onopenSkills,
		onopenProviders,
		onopenJobs,
		onopenAgents,
		onopenTheme,
		onopenShortcuts,
		onopenApprovals,
		onopenUsage,
		onshowArchived,
		onshowTrash
	}: Props = $props();

	interface Entry {
		icon: IconName;
		label: string;
		hint: string;
		run: () => void;
	}

	/**
	 * Grouped by what the entry acts on, not by what it happens to open.
	 *
	 * The seven of these used to sit as a wrapped grid of emoji buttons at the
	 * foot of the sidebar, in whatever order they were added — a shelf, not a
	 * menu. Sorting them into "your conversations", "what the agent can do" and
	 * "the app itself" is most of what makes this readable.
	 */
	let sections = $derived<Array<{ title: string; entries: Entry[] }>>([
		{
			title: 'Conversations',
			entries: [
				{
					icon: 'archive',
					label: 'Archivées',
					hint: 'Masquées des listes, retrouvées à la demande',
					run: onshowArchived
				},
				{
					icon: 'trash',
					label: 'Corbeille',
					hint: 'Supprimées, restaurables 30 jours',
					run: onshowTrash
				}
			]
		},
		{
			title: 'Agent',
			entries: [
				{
					icon: 'users',
					label: 'Agents',
					hint: "Personas, prompts et équipes",
					run: onopenAgents
				},
				{
					icon: 'clock',
					label: 'Tâches planifiées',
					hint: 'Exécutées seules, même app fermée',
					run: onopenJobs
				},
				{ icon: 'book', label: 'Skills', hint: 'Éditer les SKILL.md du disque', run: onopenSkills },
				{
					icon: 'key',
					label: 'Approbations',
					hint: 'Ce que Yadai peut lancer sans demander',
					run: onopenApprovals
				},
				{
					icon: 'plug',
					label: 'Providers',
					hint: 'Clés API, comptes OAuth, modèle par défaut',
					run: onopenProviders
				}
			]
		},
		{
			title: 'Application',
			entries: [
				{
					icon: 'contrast',
					label: 'Apparence',
					hint: 'Palette, mode clair ou sombre, accents',
					run: onopenTheme
				},
				{
					icon: 'keyboard',
					label: 'Raccourcis clavier',
					hint: "Tout se pilote sans la souris",
					run: onopenShortcuts
				},
				{
					icon: 'chart',
					label: 'Consommation',
					hint: 'Tokens, coût et outils sur 7, 30 ou 90 jours',
					run: onopenUsage
				},
				{
					icon: 'activity',
					label: 'État du système',
					hint: chat.connected === false ? 'Hors ligne' : `Yadai ${chat.version || '—'}`,
					run: onopenStatus
				}
			]
		}
	]);

	/**
	 * One dialog at a time.
	 *
	 * This panel is a doorway, not a destination: opening what an entry points
	 * at has to close it first, or two modals end up stacked and the focus trap
	 * of the one underneath fights the one on top (point 22).
	 */
	function go(run: () => void) {
		onclose();
		run();
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

<Modal {open} title="Réglages" width={480} {onclose}>
	{#snippet subtitle()}Tout ce qui n'est pas la conversation{/snippet}
	<div class="body">
		{#each sections as section (section.title)}
			<h3>{section.title}</h3>
			<div class="group">
				{#each section.entries as entry (entry.label)}
					<button class="entry" onclick={() => go(entry.run)}>
						<span class="chip"><Icon name={entry.icon} size={19} /></span>
						<span class="text">
							<span class="label">{entry.label}</span>
							<span class="hint">{entry.hint}</span>
						</span>
						<span class="chev"><Icon name="chevronRight" size={16} /></span>
					</button>
				{/each}
			</div>
		{/each}
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
		margin: 18px 0 8px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	h3:first-child {
		margin-top: 4px;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--gap-card);
	}
	.entry {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 56px;
		padding: 10px 14px;
		text-align: left;
		background: var(--bg-sunken);
		border-radius: var(--radius-card);
	}
	.entry:hover {
		background: var(--bg-hover);
	}
	.chip {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		flex: 0 0 auto;
		border-radius: 50%;
		background: var(--bg-raised);
		color: var(--accent);
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}
	.hint {
		font-size: 12px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chev {
		flex: 0 0 auto;
		color: var(--text-faint);
	}
</style>
