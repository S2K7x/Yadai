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
					label: 'Archived',
					hint: 'Hidden from lists, found on demand',
					run: onshowArchived
				},
				{
					icon: 'trash',
					label: 'Trash',
					hint: 'Deleted, restorable for 30 days',
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
					hint: 'Personas, prompts and teams',
					run: onopenAgents
				},
				{
					icon: 'clock',
					label: 'Scheduled tasks',
					hint: 'Run on their own, even with the app closed',
					run: onopenJobs
				},
				{ icon: 'book', label: 'Skills', hint: 'Edit the SKILL.md files on disk', run: onopenSkills },
				{
					icon: 'key',
					label: 'Approvals',
					hint: 'What Yadai may run without asking',
					run: onopenApprovals
				},
				{
					icon: 'plug',
					label: 'Providers',
					hint: 'API keys, OAuth accounts, default model',
					run: onopenProviders
				}
			]
		},
		{
			title: 'App',
			entries: [
				{
					icon: 'contrast',
					label: 'Appearance',
					hint: 'Palette, light or dark mode, accents',
					run: onopenTheme
				},
				{
					icon: 'keyboard',
					label: 'Keyboard shortcuts',
					hint: 'Everything works without a mouse',
					run: onopenShortcuts
				},
				{
					icon: 'chart',
					label: 'Usage',
					hint: 'Tokens, cost and tools over 7, 30 or 90 days',
					run: onopenUsage
				},
				{
					icon: 'activity',
					label: 'System status',
					hint: chat.connected === false ? 'Offline' : `Yadai ${chat.version || '—'}`,
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

<Modal {open} title="Settings" width={480} {onclose}>
	{#snippet subtitle()}Everything that isn't the conversation{/snippet}
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
