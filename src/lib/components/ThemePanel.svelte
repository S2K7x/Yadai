<script lang="ts">
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { formatNumber } from '$lib/format';
	import {
		DEFAULT_THEME,
		PRESETS,
		effectivePalette,
		readability,
		type ThemePreset
	} from '$lib/theme';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	let settings = $derived(theme.settings);
	let palette = $derived(effectivePalette(settings));

	// Only the accents are user-chosen; the rest of a preview swatch comes from
	// the preset, in the mode currently in use.
	const preview = (preset: ThemePreset) => (settings.mode === 'light' ? preset.light : preset.dark);

	let accentCheck = $derived(readability(palette.accent));
	let accent2Check = $derived(readability(palette.accent2));

	// A theme that could not be read must not be written on top of: every
	// control below stays disabled until it is. Opening the panel is also the
	// natural moment to retry, so a transient failure heals itself here.
	$effect(() => {
		if (open) void theme.ensureLoaded();
	});
	let blocked = $derived(!theme.loaded);

	let customised = $derived(settings.accent !== null || settings.accent2 !== null);
	let pristine = $derived(
		settings.preset === DEFAULT_THEME.preset && settings.mode === DEFAULT_THEME.mode && !customised
	);

	// The page hands Escape over while this panel is open, so it owns it.
	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Modal {open} title="Appearance" width={520} {onclose}>
	<div class="body">
		{#if theme.loadError}
			<!-- Not "Chargement…": a failed load is not a slow one, and PUT
			     /api/theme replaces the row, so a change composed now would write
			     the default palette over the saved one. -->
			<p class="fail">
				Your theme could not be loaded — the settings are locked so the saved palette is not
				overwritten. The screen shows the last palette this device knew.<br
				/>{theme.loadError}
			</p>
			<button class="retry" onclick={() => theme.reload()}>Retry</button>
		{/if}

		<h3>Mode</h3>
		<div class="modes">
			<button
				class="mode"
				class:sel={settings.mode === 'dark'}
				disabled={blocked}
				onclick={() => theme.update({ mode: 'dark' })}><Icon name="moon" /> Dark</button
			>
			<button
				class="mode"
				class:sel={settings.mode === 'light'}
				disabled={blocked}
				onclick={() => theme.update({ mode: 'light' })}><Icon name="sun" /> Light</button
			>
		</div>

		<h3>Palette</h3>
		<div class="presets">
			{#each PRESETS as preset (preset.id)}
				{@const p = preview(preset)}
				<button
					class="preset"
					class:sel={preset.id === settings.preset}
					disabled={blocked}
					onclick={() => theme.update({ preset: preset.id })}
				>
					<span class="swatch" style="background: {p.bg}">
						<span class="chip" style="background: {p.surface}"></span>
						<span class="chip round" style="background: {p.accent}"></span>
						<span class="chip round" style="background: {p.accent2}"></span>
					</span>
					<span class="pname">{preset.name}</span>
					<span class="phint">{preset.hint}</span>
				</button>
			{/each}
		</div>

		<h3>Accents</h3>
		<p class="lead">
			Everything else — hovers, borders, soft fills — is derived from these two colours, not asked for
			one by one.
		</p>

		<div class="colors">
			<label class="color">
				<input
					type="color"
					value={palette.accent}
					disabled={blocked}
					oninput={(e) => theme.update({ accent: e.currentTarget.value })}
					aria-label="Accent colour"
				/>
				<span class="cname">Accent</span>
				<span class="cval">{palette.accent}</span>
				<span class="ratio" class:warn={!accentCheck.ok}>
					{formatNumber(accentCheck.ratio, 1)}:1
				</span>
			</label>

			<label class="color">
				<input
					type="color"
					value={palette.accent2}
					disabled={blocked}
					oninput={(e) => theme.update({ accent2: e.currentTarget.value })}
					aria-label="Secondary accent colour"
				/>
				<span class="cname">Positive actions</span>
				<span class="cval">{palette.accent2}</span>
				<span class="ratio" class:warn={!accent2Check.ok}>
					{formatNumber(accent2Check.ratio, 1)}:1
				</span>
			</label>
		</div>

		{#if !accentCheck.ok || !accent2Check.ok}
			<p class="warning">
				Contrast below 4.5:1: text on this colour will be hard to read. The user bubble,
				though, is darkened automatically until white passes.
			</p>
		{/if}

		{#if customised}
			<button
				class="revert"
				disabled={blocked}
				onclick={() => theme.update({ accent: null, accent2: null })}
			>
				Back to the “{PRESETS.find((p) => p.id === settings.preset)?.name}” accents
			</button>
		{/if}

		<h3>Preview</h3>
		<div class="preview">
			<div class="pv-user">Find trains to Tel Aviv.</div>
			<div class="pv-bot">
				Here are the next departures. <code>terminal</code> was used.
				<span class="pv-badge">3 tools</span>
			</div>
			<div class="pv-row">
				<span class="pv-send">↑</span>
				<span class="pv-pill">Send</span>
				<span class="pv-dot"></span>
			</div>
		</div>

		<p class="lead">
			The choice is saved on the server: your phone and your desktop show the same
			palette.
		</p>
	</div>

	{#snippet footer()}
		<button class="reset" onclick={() => theme.reset()} disabled={pristine || blocked}>
			Reset to defaults
		</button>
		<button class="done" onclick={onclose}>Done</button>
	{/snippet}
</Modal>

<style>
	h3 {
		margin: 20px 0 8px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	h3:first-child {
		margin-top: 6px;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 4px 16px 18px;
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
		margin: 0 0 4px;
		font-size: 12.5px;
		color: var(--text-faint);
		line-height: 1.5;
	}
	.modes {
		display: flex;
		gap: 8px;
	}
	.mode {
		flex: 1;
		min-height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		font-size: 13.5px;
		color: var(--text-muted);
	}
	.mode.sel {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 8px;
	}
	.preset {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		align-items: center;
		gap: 2px 10px;
		padding: 10px 12px;
		text-align: left;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-card);
	}
	.preset:hover {
		background: var(--bg-hover);
	}
	.preset.sel {
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.swatch {
		grid-row: 1 / 3;
		display: flex;
		align-items: center;
		gap: 3px;
		width: 42px;
		height: 42px;
		padding: 5px;
		border-radius: var(--radius-card);
		border: 1px solid var(--border-soft);
	}
	.chip {
		width: 8px;
		height: 22px;
		border-radius: 3px;
	}
	.chip.round {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	.pname {
		font-size: 13.5px;
		color: var(--text);
	}
	.phint {
		font-size: 11.5px;
		color: var(--text-faint);
		line-height: 1.35;
	}
	.colors {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}
	.color {
		flex: 1 1 200px;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 6px 12px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-pill);
		cursor: pointer;
	}
	.color input {
		flex: 0 0 auto;
		width: 30px;
		height: 30px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: none;
		cursor: pointer;
	}
	/* Safari and Chrome each wrap the swatch differently; both need flattening
	   for the circle to actually look like a circle. */
	.color input::-webkit-color-swatch-wrapper {
		padding: 0;
	}
	.color input::-webkit-color-swatch {
		border: 1px solid var(--border);
		border-radius: 50%;
	}
	.cname {
		flex: 1;
		min-width: 0;
		font-size: 13px;
	}
	.cval {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.ratio {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: var(--radius-pill);
		background: var(--accent-2-soft);
		color: var(--text-muted);
	}
	.ratio.warn {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.warning {
		margin: 10px 0 0;
		padding: 9px 13px;
		border-radius: var(--radius-card);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.revert {
		margin-top: 10px;
		padding: 8px 14px;
		min-height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.revert:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.preview {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--bg);
		border-radius: var(--radius-card);
	}
	.pv-user {
		align-self: flex-end;
		max-width: 80%;
		padding: 8px 14px;
		background: var(--user-bubble);
		color: var(--user-ink);
		border-radius: var(--radius-bubble) var(--radius-bubble) 6px var(--radius-bubble);
		font-size: 13px;
	}
	.pv-bot {
		align-self: flex-start;
		max-width: 90%;
		padding: 8px 14px;
		background: var(--assistant-bubble);
		color: var(--text);
		border-radius: var(--radius-bubble) var(--radius-bubble) var(--radius-bubble) 6px;
		font-size: 13px;
	}
	.pv-bot code {
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: var(--code-bg);
	}
	.pv-badge {
		display: inline-block;
		margin-left: 4px;
		padding: 1px 9px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		color: var(--accent-ink);
		font-size: 11px;
	}
	.pv-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pv-send {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--accent-2);
		color: var(--accent-2-ink);
		font-size: 15px;
	}
	.pv-pill {
		padding: 4px 14px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		color: var(--text-muted);
		font-size: 12px;
	}
	.pv-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--ok);
	}
	.reset,
	.done {
		min-height: 44px;
		padding: 6px 18px;
		border-radius: var(--radius-pill);
		font-size: 13px;
	}
	.done {
		margin-left: auto;
	}
	.reset {
		border: 1px solid var(--border);
		color: var(--text-muted);
	}
	.reset:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.reset:not(:disabled):hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.done {
		background: var(--accent-2);
		color: var(--accent-2-ink);
		font-weight: 600;
	}
</style>
