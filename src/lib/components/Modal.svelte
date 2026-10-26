<script lang="ts">
	import Icon from './Icon.svelte';
	import { type Snippet } from 'svelte';
	import { dialogFocus, trapTab } from '$lib/client/dialog.svelte';

	/**
	 * The shell every settings panel shares: scrim, centred dialog, title bar
	 * with a close button, optional footer — and, under 820px, the bottom sheet
	 * of point 20 in CLAUDE.md.
	 *
	 * It owns the *frame* only. Escape stays with the panel, because what it
	 * means differs (back out of a form, guard unsaved edits, close), and the
	 * body keeps its own padding and layout.
	 *
	 * It also owns the focus, which no panel did: focus enters the dialog when
	 * it opens, Tab cannot walk out of it into the page underneath, and closing
	 * puts the caret back where it came from.
	 */
	interface Props {
		open: boolean;
		/** Title bar text. Also the accessible name unless `label` overrides it. */
		title: string;
		label?: string;
		/** Natural width in px; the frame still shrinks to fit a narrow window. */
		width: number;
		/** Take the full available height instead of hugging the content. */
		fill?: boolean;
		/** Scrim click and the close button. The panel decides what closing means. */
		onclose: () => void;
		subtitle?: Snippet;
		children: Snippet;
		footer?: Snippet;
	}
	let { open, title, label, width, fill = false, onclose, subtitle, children, footer }: Props =
		$props();

	let card = $state<HTMLElement | null>(null);

	/**
	 * Focus follows the dialog: onto the card when it opens — so a screen reader
	 * announces the dialog before its contents — and back to whatever opened it
	 * on close, usually the rail button, so the next Tab carries on from there
	 * instead of restarting at the top of the page. The mobile drawer of
	 * `Sidebar.svelte` shares both behaviours.
	 */
	dialogFocus(
		() => open,
		() => card
	);
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="scrim" onclick={onclose}></div>
	<div
		class="panel"
		class:fill
		bind:this={card}
		onkeydown={(event) => card && trapTab(card, event)}
		role="dialog"
		aria-modal="true"
		aria-label={label ?? title}
		tabindex="-1"
		style="--panel-width: {width}px"
	>
		<header>
			<h2>{title}</h2>
			{#if subtitle}<span class="sub">{@render subtitle()}</span>{/if}
			<button class="x" onclick={onclose} aria-label="Close"><Icon name="close" /></button>
		</header>

		{@render children()}

		{#if footer}
			<footer>{@render footer()}</footer>
		{/if}
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 150;
		background: var(--scrim);
	}
	.panel {
		position: fixed;
		z-index: 151;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(var(--panel-width), calc(100vw - 20px));
		max-height: min(88vh, calc(100dvh - 20px));
		display: flex;
		flex-direction: column;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
		overflow: hidden;
	}
	/* The card takes the focus when it opens so the dialog is announced; the
	   announcement is the signal, a ring around the whole panel is not. */
	.panel:focus {
		outline: none;
	}
	.panel.fill {
		height: min(88vh, calc(100dvh - 20px));
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 18px 20px 10px;
	}
	h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.sub {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: 12px;
	}
	.x {
		margin-left: auto;
		padding: 2px 6px;
		color: var(--text-faint);
	}
	footer {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 20px 18px;
	}

	/* Phone: come up from the bottom edge instead of floating in the middle,
	   rounded on top only. Margins on a 390px screen are lost width. */
	@media (max-width: 820px) {
		.panel {
			top: auto;
			bottom: 0;
			left: 0;
			transform: none;
			width: 100%;
			max-height: 92dvh;
			border-radius: var(--radius-panel) var(--radius-panel) 0 0;
			padding-bottom: env(safe-area-inset-bottom);
		}
		/* The grabber every bottom sheet wears: it says the surface came up
		   from the edge, before anyone reads the title. Decorative, so it is
		   drawn rather than added to the markup and the a11y tree. */
		.panel::before {
			content: '';
			position: absolute;
			top: 8px;
			left: 50%;
			transform: translateX(-50%);
			width: 38px;
			height: 4px;
			border-radius: var(--radius-pill);
			background: var(--border);
		}
		header {
			padding-top: 22px;
		}
		/* Thumb-sized close target where a thumb is what taps it. */
		.x {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
