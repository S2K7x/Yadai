<script lang="ts">
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import { approvals } from '$lib/stores/approvals.svelte';
	import { APPROVAL_MODES, modeStrandsWebUi, type ApprovalMode } from '$lib/approvals';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	let denyDraft = $state('');
	let allowDraft = $state('');

	// Opening is the natural moment to retry a failed read, exactly like the
	// appearance and providers panels.
	$effect(() => {
		if (open) void approvals.ensureLoaded();
	});
	let blocked = $derived(!approvals.available || approvals.saving);

	const MODES: Record<ApprovalMode, { label: string; hint: string }> = {
		smart: {
			label: 'Smart',
			hint: 'An auxiliary model judges each dangerous command and approves most of them. This is the default.'
		},
		manual: {
			label: 'Manual',
			hint: 'Every dangerous command asks for human approval.'
		},
		off: {
			label: 'Off',
			hint: 'No approval is asked any more, anywhere.'
		}
	};

	async function setMode(mode: ApprovalMode) {
		if (mode === approvals.policy.mode) return;
		if (mode === 'off') {
			const ok = confirm(
				"Turn approvals off?\n\nNo dangerous command will need approval any more — not here, not from the CLI, not from Telegram, not for scheduled tasks. Hermes' safety floor (rm -rf /, mkfs, raw disk writes…) stays in place, but everything else goes through without a question."
			);
			if (!ok) return;
		}
		await approvals.setMode(mode);
	}

	async function addDeny() {
		const value = denyDraft;
		denyDraft = '';
		await approvals.addRule('deny', value);
	}
	async function addAllow() {
		const value = allowDraft;
		allowDraft = '';
		await approvals.addRule('allowlist', value);
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

<Modal {open} title="Approvals" width={560} {onclose}>
	{#snippet subtitle()}What Yadai may run without asking{/snippet}
	<div class="body">
		{#if !approvals.available}
			<p class="fail">
				{approvals.message || (approvals.loading ? 'Reading…' : 'The policy could not be read.')}
			</p>
			{#if !approvals.loading}
				<button class="retry" onclick={() => approvals.load()}>Retry</button>
			{/if}
		{/if}

		<h3>Mode</h3>
		<div class="modes">
			{#each APPROVAL_MODES as mode (mode)}
				<button
					class="mode"
					class:sel={approvals.policy.mode === mode}
					class:danger={mode === 'off'}
					disabled={blocked}
					onclick={() => setMode(mode)}
				>
					<span class="m-name">{MODES[mode].label}</span>
					<span class="m-hint">{MODES[mode].hint}</span>
				</button>
			{/each}
		</div>

		{#if modeStrandsWebUi(approvals.policy.mode)}
			<!-- The one thing this panel exists to make visible: in manual mode the
			     web UI cannot answer its own prompts, so every dangerous command
			     becomes a dead end here. See $lib/approvals for the measurement. -->
			<p class="warn">
				<Icon name="warning" size={15} /> In manual mode, this interface cannot grant
				any approval: Hermes only offers a button on the CLI and in messaging apps. A
				dangerous command will therefore stop here with no way forward. Smart mode decides
				on its own.
			</p>
		{/if}

		<h3>Always deny</h3>
		<p class="lead">
			<code>fnmatch</code> patterns blocked <strong>unconditionally</strong>, even before the mode
			above. A deny here beats everything else. Takes effect immediately.
		</p>
		<div class="add">
			<input
				bind:value={denyDraft}
				placeholder="git push --force*"
				disabled={blocked}
				onkeydown={(e) => e.key === 'Enter' && addDeny()}
				aria-label="New pattern to deny"
			/>
			<button disabled={blocked || !denyDraft.trim()} onclick={addDeny}>Add</button>
		</div>
		<ul class="rules">
			{#each approvals.policy.deny as rule (rule)}
				<li>
					<code>{rule}</code>
					<button
						disabled={blocked}
						onclick={() => approvals.removeRule('deny', rule)}
						aria-label="Remove {rule}"><Icon name="close" size={13} /></button
					>
				</li>
			{:else}
				<li class="none">No denied patterns.</li>
			{/each}
		</ul>

		<h3>Always allow</h3>
		<p class="lead">
			Commands approved once and for all — exact text or wildcard
			(<code>podman *</code>). <strong>Requires a gateway restart</strong>:
			this list is only read when Hermes starts, unlike the two settings
			above.
		</p>
		<div class="add">
			<input
				bind:value={allowDraft}
				placeholder="docker compose ps"
				disabled={blocked}
				onkeydown={(e) => e.key === 'Enter' && addAllow()}
				aria-label="New command to allow"
			/>
			<button disabled={blocked || !allowDraft.trim()} onclick={addAllow}>Add</button>
		</div>
		<ul class="rules">
			{#each approvals.policy.allowlist as rule (rule)}
				<li>
					<code>{rule}</code>
					<button
						disabled={blocked}
						onclick={() => approvals.removeRule('allowlist', rule)}
						aria-label="Remove {rule}"><Icon name="close" size={13} /></button
					>
				</li>
			{:else}
				<li class="none">No pre-approved commands.</li>
			{/each}
		</ul>

		<p class="lead foot">
			These are Hermes' settings, not this interface's: they also apply to the CLI,
			messaging apps and scheduled tasks. After adding to "always allow":
			<code>systemctl --user restart hermes-gateway</code>.
		</p>
		<!-- Observed while writing this panel, not inferred: saving goes through
		     the dashboard, which re-serialises config.yaml and drops comments
		     written by hand. Better to say so here than to find out. -->
		<p class="lead">
			<Icon name="warning" size={13} /> Saving rewrites <code>~/.hermes/config.yaml</code> through
			the Hermes dashboard, which does not keep any comments you may have written there.
		</p>
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
		margin: 20px 0 8px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	h3:first-child {
		margin-top: 6px;
	}
	.fail {
		margin: 8px 0 6px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--danger);
	}
	.retry {
		margin-bottom: 4px;
		font-size: 13px;
		color: var(--accent);
	}
	.lead {
		margin: 0 0 10px;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--text-faint);
	}
	.lead code,
	.rules code {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: var(--code-bg);
	}
	.foot {
		margin-top: 18px;
	}
	.modes {
		display: flex;
		flex-direction: column;
		gap: var(--gap-card);
	}
	.mode {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 11px 14px;
		min-height: 56px;
		text-align: left;
		background: var(--bg-sunken);
		border: 1px solid transparent;
		border-radius: var(--radius-card);
	}
	.mode:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.mode.sel {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.mode.danger.sel {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
	.mode:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.m-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}
	.m-hint {
		font-size: 12px;
		color: var(--text-faint);
		line-height: 1.45;
	}
	.warn {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 12px 0 0;
		padding: 11px 14px;
		border-radius: var(--radius-card);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 12.5px;
		line-height: 1.55;
	}
	.add {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.add input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		padding: 10px 14px;
		background: var(--bg-sunken);
		border: none;
		border-radius: var(--radius-pill);
		font-size: 13px;
	}
	.add button {
		flex: 0 0 auto;
		min-height: 44px;
		padding: 8px 16px;
		border-radius: var(--radius-pill);
		background: var(--accent-2);
		color: var(--accent-2-ink);
		font-size: 13px;
		font-weight: 600;
	}
	.add button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.rules {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.rules li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 8px 7px 12px;
		background: var(--bg-sunken);
		border-radius: var(--radius-card);
	}
	.rules li code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		background: none;
		padding: 0;
	}
	.rules li button {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		color: var(--text-faint);
	}
	.rules li button:hover:not(:disabled) {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.none {
		color: var(--text-faint);
		font-size: 12.5px;
	}

	@media (max-width: 820px) {
		.rules li button {
			width: 44px;
			height: 44px;
		}
	}
</style>
