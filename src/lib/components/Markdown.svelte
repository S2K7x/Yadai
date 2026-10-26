<script lang="ts">
	import {
		hasCodeBlocks,
		highlightCodeBlocks,
		highlighterReady,
		loadHighlighter,
		renderDelayMs,
		renderMarkdown,
		stablePrefixEnd
	} from '$lib/markdown';
	import { onDestroy, tick } from 'svelte';

	interface Props {
		source: string;
		streaming?: boolean;
	}
	let { source, streaming = false }: Props = $props();

	/**
	 * The message, in two pieces.
	 *
	 * `head` is the HTML of the part of a streaming answer that markdown
	 * guarantees can no longer change — see `stablePrefixEnd`. It is written
	 * once per section and then left alone, which is what keeps its DOM out of
	 * the swap below. `tail` is the part still being written, re-rendered on
	 * every debounce tick as before.
	 *
	 * A finished message has no head at all: the final render is one
	 * whole-buffer parse, exactly as it was. So the worst a mis-chosen boundary
	 * could ever cost is a moment of odd layout mid-stream, corrected the
	 * instant the turn ends.
	 */
	let head = $state('');
	let tail = $state('');
	/** Source text whose HTML is in `head`. Always a prefix of `source`. */
	let headSrc = '';
	/** Set when the text holds something that makes freezing a prefix unsafe. */
	let noSplit = false;
	let container = $state<HTMLDivElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	/** Set once the grammar bundle has been asked for, so the scan below stops. */
	let warmed = false;

	function render() {
		if (!streaming) {
			// The authoritative pass: one parse of the whole buffer, no split.
			headSrc = '';
			head = '';
			tail = renderMarkdown(source);
			return;
		}
		// `assistant.completed` replaces the buffer rather than appending to it,
		// and it can land while `streaming` is still true. A cheap prefix test
		// (a memcmp, against milliseconds of parsing) catches that.
		if (!source.startsWith(headSrc)) {
			headSrc = '';
			head = '';
		}
		if (!noSplit) {
			const cut = stablePrefixEnd(source, headSrc.length);
			if (cut < 0) {
				// Back to rendering the whole buffer for the rest of the message.
				noSplit = true;
				headSrc = '';
				head = '';
			} else if (cut > headSrc.length) {
				// Only the new sections are parsed. Each one is a complete run of
				// blocks bounded by a hard block start, so rendering them apart
				// and concatenating gives what one parse of the prefix gives.
				head += renderMarkdown(source.slice(headSrc.length, cut));
				headSrc = source.slice(0, cut);
			}
		}
		tail = renderMarkdown(source.slice(headSrc.length), true);
		// A fence has appeared mid-stream: start fetching the grammar bundle now
		// so it is resident when the turn ends, instead of flashing plain code
		// first. Checked here rather than per token — this runs on the debounce.
		if (!warmed && source.includes('```')) {
			warmed = true;
			loadHighlighter();
		}
	}

	// While streaming, re-parse on a timer instead of per token: a full markdown
	// parse at frame rate saturates the Pi's CPU. The interval is not fixed —
	// a re-render costs about a millisecond per kilobyte of answer, all of it
	// redone from scratch, so a flat cadence would let a long turn spend half a
	// core redrawing text the reader is nowhere near. `renderDelayMs` stretches
	// the wait with the message so the *rate* of work stays flat; short answers
	// keep the 70 ms typewriter unchanged. When the stream ends, render once
	// immediately so the final text is never stale.
	$effect(() => {
		void source;
		if (!streaming) {
			if (timer) clearTimeout(timer);
			timer = null;
			render();
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			render();
		}, renderDelayMs(source.length));
	});

	// Syntax highlighting and copy buttons, only once the message is final —
	// decorating a growing block redoes the work on every pass for nothing.
	//
	// The `tick()` is not cosmetic. `tail` is assigned from inside the effect
	// above, so when this effect body runs Svelte has not yet written
	// `{@html tail}` to the DOM: touching `container` here would decorate the
	// *previous* markup, which the pending swap then throws away. That is why
	// neither highlighting nor the copy button ever appeared (verified against
	// the live app: a transcript with 13 code blocks had zero `.hljs-*` spans
	// and zero buttons). Post-processing has to wait for the flush.
	$effect(() => {
		void tail;
		if (streaming || !container) return;
		const root = container;
		let cancelled = false;
		const alive = () => !cancelled && root.isConnected;
		void (async () => {
			await tick();
			if (!alive()) return;
			decorateCodeBlocks(root);
			if (!hasCodeBlocks(root)) return;
			// Nothing to await once the grammars are resident — the common case
			// after the first code block, and the one that must not flash.
			if (!highlighterReady()) await loadHighlighter();
			if (alive()) highlightCodeBlocks(root);
		})();
		return () => {
			cancelled = true;
		};
	});

	/** Add a copy button to each finished code block. */
	function decorateCodeBlocks(root: HTMLElement) {
		for (const pre of root.querySelectorAll<HTMLPreElement>('pre:not([data-decorated])')) {
			pre.dataset.decorated = '1';
			pre.classList.add('code-wrap');
			const button = document.createElement('button');
			button.type = 'button';
			button.dataset.copy = '1';
			button.className = 'copy-btn';
			button.textContent = 'copy';
			pre.prepend(button);
		}
	}

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});

	function onCopy(event: MouseEvent) {
		const button = (event.target as HTMLElement).closest<HTMLElement>('[data-copy]');
		if (!button || !container) return;
		const code = button.closest('pre')?.querySelector('code');
		if (!code) return;
		navigator.clipboard.writeText(code.textContent ?? '');
		button.textContent = 'copied';
		setTimeout(() => (button.textContent = 'copy'), 1400);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="md" bind:this={container} onclick={onCopy}>{@html head}{@html tail}</div>

<style>
	.md {
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	.md :global(pre.code-wrap) {
		position: relative;
	}

	.md :global(.copy-btn) {
		position: absolute;
		top: 6px;
		right: 8px;
		z-index: 1;
		padding: 2px 8px;
		font-size: 11px;
		color: var(--text-faint);
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		border-radius: 5px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.md :global(pre.code-wrap:hover .copy-btn),
	.md :global(.copy-btn:focus-visible) {
		opacity: 1;
	}

	/* Touch devices have no hover; keep it permanently visible there — and
	   give it a strip of its own, or it sits on top of the first line of
	   code, which is exactly the line a narrow screen has no room to spare. */
	@media (hover: none) {
		.md :global(.copy-btn) {
			opacity: 0.85;
		}
		.md :global(pre.code-wrap code) {
			padding-top: 2.6em;
		}
	}
</style>
