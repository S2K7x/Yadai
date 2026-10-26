<script lang="ts">
	import Icon from './Icon.svelte';
	import { toasts } from '$lib/stores/toast.svelte';
	import { flip } from 'svelte/animate';
	import { fly } from 'svelte/transition';
</script>

<div class="stack" role="status" aria-live="polite">
	{#each toasts.items as toast (toast.id)}
		<div
			class="toast {toast.kind}"
			animate:flip={{ duration: 180 }}
			in:fly={{ y: 12, duration: 160 }}
			out:fly={{ y: 8, duration: 120 }}
		>
			<span class="icon">
				<Icon name={toast.kind === 'error' ? 'warning' : toast.kind === 'success' ? 'check' : 'info'} />
			</span>
			<span class="msg">{toast.message}</span>
			{#if toast.action}
				<button
					class="action"
					onclick={() => {
						toast.action?.run();
						toasts.dismiss(toast.id);
					}}>{toast.action.label}</button
				>
			{/if}
			<button class="close" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}><Icon name="close" size={14} /></button>
		</div>
	{/each}
</div>

<style>
	.stack {
		position: fixed;
		z-index: 200;
		/* Clear of the composer, which is centred and can be 780px wide. */
		bottom: calc(96px + env(safe-area-inset-bottom));
		right: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: min(420px, calc(100vw - 32px));
		pointer-events: none;
	}
	.toast {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 10px 12px;
		background: var(--bg-raised);
		box-shadow: var(--shadow-float);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow);
		font-size: 13.5px;
		line-height: 1.45;
		pointer-events: auto;
	}
	.toast.error {
		border-color: var(--danger);
	}
	.toast.success {
		border-color: var(--ok);
	}
	.icon {
		flex: 0 0 auto;
		line-height: 1.4;
	}
	.msg {
		flex: 1;
		min-width: 0;
		word-break: break-word;
	}
	.action {
		flex: 0 0 auto;
		padding: 2px 9px;
		box-shadow: var(--shadow-float);
		border-radius: 6px;
		font-size: 12.5px;
		color: var(--accent);
	}
	.action:hover {
		background: var(--bg-hover);
	}
	.close {
		flex: 0 0 auto;
		padding: 0 2px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.close:hover {
		color: var(--text);
	}

	@media (max-width: 820px) {
		.stack {
			left: 12px;
			right: 12px;
			bottom: calc(84px + env(safe-area-inset-bottom));
			max-width: none;
		}
	}
</style>
