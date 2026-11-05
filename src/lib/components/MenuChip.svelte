<script lang="ts">
	import type { Snippet } from 'svelte';
	import { menuKeydown } from '$lib/client/menu.svelte';

	/**
	 * The shell the two header pickers share: the pill-shaped trigger, the
	 * scrim, the floating panel anchored under it — and, under 820px, the
	 * bottom sheet of point 20 in CLAUDE.md.
	 *
	 * Same split as `Modal.svelte`, and for the same reason. The model picker
	 * and the agent picker each carried their own copy of this frame: the
	 * `open` flag, the two element refs, `close(refocus)`, the `menuKeydown`
	 * wrapper, the Safari click-focus, `aria-haspopup`/`aria-expanded`, and
	 * some seventy identical lines of CSS. The copies had already drifted —
	 * the agent panel never got the `flex: none` that keeps a two-line row
	 * from being clipped by the 44px touch floor, though its rows are two
	 * lines too.
	 *
	 * It owns the *frame* only. The chip's content, the panel's content and
	 * the row styling stay with the picker: a selector written here would not
	 * reach markup written there anyway, which is Svelte's scoping.
	 */
	interface Props {
		/** Accessible name of the trigger — it must say what is selected. */
		label: string;
		/** Native tooltip of the trigger, usually the full value. */
		title?: string;
		/** Natural width of the panel in px; it still shrinks on a narrow window. */
		width: number;
		/** Cap on the trigger, which ellipsises what it cannot fit. */
		triggerWidth: number;
		/** The chip's own content: the value, a badge, whatever names it. */
		chip: Snippet;
		/**
		 * The panel's content. Receives the closer, because choosing a row is
		 * what dismisses the panel and only the picker knows which row that is.
		 * `close(true)` hands the focus back to the chip; `close()` leaves it
		 * alone, for an entry that opens something else.
		 */
		menu: Snippet<[(refocus?: boolean) => void]>;
	}
	let { label, title, width, triggerWidth, chip, menu }: Props = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let panel = $state<HTMLDivElement | null>(null);

	/** Escape hands the focus back to the button the list came from. */
	function close(refocus = false) {
		open = false;
		if (refocus) trigger?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="picker"
	onkeydown={(event) => {
		if (open && menuKeydown(panel, event) === 'close') close(true);
	}}
>
	<button
		class="trigger"
		bind:this={trigger}
		style="--trigger-width: {triggerWidth}px"
		onclick={(event) => {
			// Safari does not focus a clicked button; without this, Escape would
			// be typed at <body> and reach the page handler, where it means
			// "close the drawer" or "detach the running turn".
			event.currentTarget.focus();
			open = !open;
		}}
		aria-haspopup="true"
		aria-expanded={open}
		aria-label={label}
		{title}
	>
		{@render chip()}
		<span class="chev" aria-hidden="true">▾</span>
	</button>

	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" onclick={() => close()}></div>
		<div class="menu" bind:this={panel} style="--menu-width: {width}px">
			{@render menu(close)}
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
		max-width: var(--trigger-width);
		overflow: hidden;
		white-space: nowrap;
	}
	.trigger:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chev {
		flex: 0 0 auto;
		font-size: 9px;
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
		width: min(var(--menu-width), 88vw);
		padding: 9px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
	}

	/* Touch: a header control is as much a target as any other, and both chips
	   were measured at 34px tall on a phone.

	   Phone: a bottom sheet, not a dropdown. The chip sits on the header's
	   second row, wherever the title left it; a sheet is anchored to the
	   screen instead, within reach of a thumb, and wide enough for a model id
	   and its price. */
	@media (max-width: 820px) {
		.trigger {
			min-height: 44px;
		}
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
	}
</style>
