<script lang="ts">
	import Icon from './Icon.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { perFrame } from '$lib/client/frame';
	import { menuKeydown } from '$lib/client/menu.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { drafts } from '$lib/stores/drafts.svelte';
	import { prompts } from '$lib/stores/prompts.svelte';
	import { toasts } from '$lib/stores/toast.svelte';
	import { matchPrompts } from '$lib/prompts';
	import { formatBytes } from '$lib/skills';
	import {
		MAX_TEXT_FILE_BYTES,
		displayName,
		inlineTextFile,
		refusalMessage
	} from '$lib/attach';
	import { restoreDraft } from '$lib/drafts';
	import { uid } from '$lib/transcript';
	import type { Attachment } from '$lib/types';

	interface Props {
		/**
		 * Under 820px. The bar has about 160px left for its field once the
		 * three round controls are out, so the placeholder's parenthetical
		 * hint would wrap and make an empty composer two rows tall. The page
		 * already tracks this width for the drawer; it is passed down rather
		 * than measured a second time here.
		 */
		narrow?: boolean;
	}
	let { narrow = false }: Props = $props();

	/**
	 * The conversation the text below belongs to.
	 *
	 * This component is mounted once for the whole app, so without this the
	 * composer's contents simply followed the user from one conversation to the
	 * next — one Enter away from being sent to the wrong agent.
	 */
	let boundId = $state<string | null>(chat.sessionId);
	let text = $state(drafts.get(chat.sessionId));
	let attachments = $state<Attachment[]>([]);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let dragging = $state(false);
	let notice = $state<string | null>(null);

	// Skills palette: typing "/" at the start of the composer opens it.
	let paletteOpen = $state(false);
	let paletteIndex = $state(0);
	let skillList = $state<HTMLDivElement | null>(null);
	let paletteQuery = $derived(text.startsWith('/') ? text.slice(1).split(/\s/)[0].toLowerCase() : '');
	let paletteMatches = $derived(
		paletteOpen
			? chat.skills.filter((s) => s.name.toLowerCase().includes(paletteQuery)).slice(0, 8)
			: []
	);
	/** Prefix of the row ids `aria-activedescendant` points at. */
	const SKILL_OPTION_ID = 'composer-skill-';

	/**
	 * Keep the highlighted skill on screen.
	 *
	 * The list caps at eight matches and the popup at 260px: **measured at
	 * 414×896**, eight rows are 350px of content in a 260px box, and walking
	 * the cursor to the last one left it 301px down a list 260px tall with
	 * `scrollTop` still at 0. Enter then ran a skill that had never been
	 * visible — the same blind cursor the command palette had.
	 */
	$effect(() => {
		void paletteMatches.length;
		const i = paletteIndex;
		if (!paletteOpen || !skillList) return;
		skillList.querySelector<HTMLElement>(`#${SKILL_OPTION_ID}${i}`)?.scrollIntoView({
			block: 'nearest'
		});
	});

	// Saved prompts: the library lives server-side, so it is the same on the
	// phone and on the desktop.
	let promptsOpen = $state(false);
	let promptFilter = $state('');
	let promptTrigger = $state<HTMLButtonElement | null>(null);
	let promptPanel = $state<HTMLDivElement | null>(null);
	let promptMatches = $derived(matchPrompts(prompts.items, promptFilter));
	const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

	/** Escape hands the focus back to the button the library came from. */
	function closePrompts(refocus = false) {
		promptsOpen = false;
		if (refocus) promptTrigger?.focus();
	}

	/**
	 * The library is a popup menu like the three in the header and the sidebar,
	 * so it owes the keyboard the same contract.
	 *
	 * It was pointer-only everywhere but the composer field: **measured**, an
	 * Escape pressed on a control *inside* the popup left it open and reached
	 * the window handler of `+page.svelte`, where a bare Escape means "close
	 * the drawer" or, while a turn streams, "detach the answer". Dismissing a
	 * list of prompts must never do that.
	 */
	function onPromptKeydown(event: KeyboardEvent) {
		if (!promptsOpen) return;
		if (menuKeydown(promptPanel, event) === 'close') closePrompts(true);
	}

	/**
	 * Park the text on the conversation being left, pick up the one being
	 * opened. `untrack` keeps this effect keyed on the session id alone, so it
	 * does not re-run on every keystroke.
	 */
	$effect(() => {
		const id = chat.sessionId;
		untrack(() => {
			if (id === boundId) return;
			drafts.set(boundId, text);
			boundId = id;
			text = drafts.get(id);
			paletteOpen = false;
			promptsOpen = false;
			autosize();
		});
	});

	// A draft restored at mount arrives before the textarea is bound, so its
	// height would stay at one line until the first keystroke.
	$effect(() => {
		if (textarea) untrack(autosize);
	});

	const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

	/** Text the inline height was last measured for. */
	let sizedFor: string | null = null;

	/**
	 * Grow the box to fit its draft, on a frame and only when it can have moved.
	 *
	 * Three writes and a read: clearing the inline height invalidates layout,
	 * so reading `scrollHeight` back forces the browser to lay the document out
	 * on the spot. This ran on every keystroke, and twice during boot — once
	 * when the textarea binds and once when the draft for the opening
	 * conversation is picked up, with nothing in between to change the answer.
	 *
	 * So: at most once per frame (see `perFrame`, which also explains why the
	 * box still grows in the same frame as the character that widened it), and
	 * skipped outright when the text has not changed since the last
	 * measurement. The guard is what makes the duplicate boot pass free; the
	 * frame is what makes a fast typist, a paste or a held key cost one layout
	 * instead of one per event.
	 *
	 * **Measured on this Pi 5**, headless Chromium, 200 keystrokes into this
	 * box with a 20-message thread behind it:
	 *
	 * | | before | after |
	 * |---|---|---|
	 * | forced `scrollHeight` reads | 200 | 43 |
	 * | time inside those reads | 88 ms | 27 ms |
	 * | layouts / style recalcs | 600 / 601 | 286 / 318 |
	 * | main-thread task time | 638 ms | 463 ms |
	 *
	 * And the case that actually hurts on this box — typing while a turn is
	 * streaming at 480 chars/s, so the thread is growing under the box:
	 *
	 * | | before | after |
	 * |---|---|---|
	 * | forced reads / time | 254 / 95 ms | 94 / 27 ms |
	 * | layouts | 608 | 305 |
	 * | main-thread task time | 702 ms | 530 ms |
	 * | wall time for the 200 keys | 998 ms | 820 ms |
	 *
	 * Boot loses one of its two passes outright: the forced-layout time
	 * attributed to `scrollHeight` over eight cold loads goes 35 ms → 24 ms,
	 * though the boot total stays inside the run-to-run spread.
	 */
	const sizer = perFrame(() => {
		if (!textarea || textarea.value === sizedFor) return;
		sizedFor = textarea.value;
		textarea.style.height = 'auto';
		// `max-height` in the stylesheet already caps the box; this keeps the
		// inline value honest so a shrink back below the cap is measured.
		textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
	});

	function autosize() {
		sizer.schedule();
	}

	onDestroy(() => sizer.cancel());

	function flash(message: string) {
		notice = message;
		setTimeout(() => (notice = null), 4000);
	}

	// Images travel as base64 inside the JSON body, which inflates them ~33%.
	// Keep the total under the server's BODY_SIZE_LIMIT (8 MB) with room to
	// spare, and say so before the turn fails upstream.
	const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
	let totalBytes = $derived(attachments.reduce((sum, a) => sum + a.size, 0));

	/**
	 * Only images can be *attached*. The Hermes API rejects uploaded files,
	 * file_id references and non-image data: URLs with
	 * 400 unsupported_content_type, so anything else that is text is inlined
	 * into the message instead — the prompt is the one channel that has always
	 * accepted it. Anything that is neither is refused with an explanation
	 * rather than failing mid-turn.
	 */
	async function addFiles(files: FileList | File[]) {
		for (const file of Array.from(files)) {
			if (!file.type.startsWith('image/')) {
				await inlineFile(file);
				continue;
			}
			if (file.size > MAX_IMAGE_BYTES) {
				flash(`« ${file.name} » ignoré : dépasse 4 Mo.`);
				continue;
			}
			if (totalBytes + file.size > MAX_TOTAL_BYTES) {
				flash(`« ${file.name} » ignoré : le lot dépasserait 5 Mo au total.`);
				continue;
			}
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = reject;
				reader.readAsDataURL(file);
			});
			attachments.push({
				id: uid('att'),
				name: file.name || 'image',
				mime: file.type,
				dataUrl,
				size: file.size
			});
		}
	}

	/**
	 * Read a non-image file and append it to the message as a fenced block.
	 *
	 * The byte gate comes first, before anything is decoded: a dropped video is
	 * refused on its size rather than after a hundred megabytes have gone
	 * through a UTF-8 decoder. What comes back from `File.text()` is then
	 * judged on its content, not on its extension — that is what lets a
	 * `Dockerfile` or a `.env.example` in without a list to maintain.
	 */
	async function inlineFile(file: File) {
		const name = displayName(file.name);
		if (file.size > MAX_TEXT_FILE_BYTES) {
			flash(`« ${name} » ignoré : ${formatBytes(file.size)}, au-delà des 512 Ko lisibles d'un coup.`);
			return;
		}
		let content: string;
		try {
			content = await file.text();
		} catch {
			flash(`« ${name} » n'a pas pu être lu.`);
			return;
		}
		const result = inlineTextFile(file.name, content);
		if (!result.ok) {
			flash(refusalMessage(file.name, result.reason, content.length));
			return;
		}
		insert(result.block);
		flash(`« ${name} » inséré dans le message (${formatBytes(file.size)}).`);
	}

	function onPaste(event: ClipboardEvent) {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length) {
			event.preventDefault();
			addFiles(files);
		}
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
	}

	function onKeydown(event: KeyboardEvent) {
		// Escape closes the prompt library first — without stopping here it
		// would reach the page handler and detach a running turn.
		if (promptsOpen && event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			// No refocus: the caret was here, and this is where it stays.
			closePrompts();
			return;
		}
		if (paletteOpen && paletteMatches.length) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				paletteIndex = (paletteIndex + 1) % paletteMatches.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				paletteIndex = (paletteIndex - 1 + paletteMatches.length) % paletteMatches.length;
				return;
			}
			if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
				event.preventDefault();
				choose(paletteMatches[paletteIndex].name);
				return;
			}
			if (event.key === 'Escape') {
				// Stopped here, like every other popup: unstopped it reached the
				// window handler as well, which reads a bare Escape as "close the
				// drawer" or, mid-turn, "detach the answer being written".
				event.preventDefault();
				event.stopPropagation();
				paletteOpen = false;
				return;
			}
		}
		// Enter sends, Shift+Enter newlines — but never on a soft keyboard,
		// where Enter has to insert a line break.
		if (event.key === 'Enter' && !event.shiftKey && !isTouch()) {
			event.preventDefault();
			submit();
		}
	}

	const isTouch = () => window.matchMedia('(hover: none)').matches;

	function choose(name: string) {
		text = `/${name} `;
		drafts.set(boundId, text);
		paletteOpen = false;
		textarea?.focus();
	}

	function onInput() {
		autosize();
		drafts.set(boundId, text);
		paletteOpen = text.startsWith('/') && !text.includes('\n') && chat.skills.length > 0;
		paletteIndex = 0;
	}

	/** Called from the page's "/" shortcut and the command palette. */
	export function focus() {
		textarea?.focus();
	}

	/**
	 * Drop a saved prompt into the composer. Appended, never substituted: a
	 * half-typed message must survive a mistaken tap on the library.
	 */
	export function insert(value: string) {
		const kept = text.replace(/\s+$/, '');
		text = kept ? `${kept}\n\n${value}` : value;
		drafts.set(boundId, text);
		promptsOpen = false;
		paletteOpen = false;
		textarea?.focus();
		autosize();
	}

	function togglePrompts() {
		promptsOpen = !promptsOpen;
		if (promptsOpen) {
			promptFilter = '';
			void prompts.ensureLoaded();
		}
	}

	async function saveCurrent() {
		if (await prompts.add(text)) toasts.success('Prompt enregistré.');
	}

	async function submit() {
		if (chat.streaming) return;
		const payload = text;
		const files = attachments;
		if (!payload.trim() && files.length === 0) return;
		// Cleared before the turn starts: `send()` may create the conversation,
		// which moves `chat.sessionId` and with it the key this text is under.
		const from = boundId;
		drafts.clear(boundId);
		text = '';
		attachments = [];
		paletteOpen = false;
		promptsOpen = false;
		autosize();
		if (!(await chat.send(payload, files))) restore(from, payload, files);
	}

	/**
	 * The turn never started, so the message is still the user's.
	 *
	 * Clearing above is what lets a brand-new conversation keep its draft key
	 * straight, but it also means a refused turn left nothing anywhere: not in
	 * the transcript (`send()` pushes the bubble only once it has an id), not in
	 * localStorage (`drafts.clear`), not in the box. **Measured** with the
	 * gateway down, `POST /api/sessions` answers 502 `hermes_unreachable` — one
	 * restart of the gateway, or a phone stepping off the tailnet, and a long
	 * message typed on a touch keyboard was gone for good.
	 *
	 * Merged rather than assigned, and only into the composer it was typed in:
	 * appending text meant for one conversation onto another is the very swap
	 * per-conversation drafts exist to prevent, so a conversation switched in
	 * the meantime gets its text parked on its own key — where the sidebar's
	 * draft marker shows it.
	 */
	function restore(from: string | null, payload: string, files: Attachment[]) {
		if (from === boundId) {
			text = restoreDraft(text, payload);
			attachments = [...files, ...attachments];
			drafts.set(boundId, text);
			autosize();
			textarea?.focus();
			flash('Message non envoyé : il est resté dans le composeur.');
		} else {
			drafts.set(from, restoreDraft(drafts.get(from), payload));
			flash('Message non envoyé : il est resté sur la conversation où il a été écrit.');
		}
	}
</script>

<div
	class="composer"
	class:dragging
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
	role="group"
>
	{#if notice}
		<div class="notice">{notice}</div>
	{/if}

	{#if promptsOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="pscrim" onclick={() => closePrompts()}></div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="palette prompts" bind:this={promptPanel} onkeydown={onPromptKeydown}>
			<div class="p-head">
				<span>Prompts enregistrés</span>
				<button class="p-x" onclick={() => closePrompts(true)} aria-label="Fermer"><Icon name="close" size={14} /></button>
			</div>

			{#if text.trim()}
				<button
					class="p-save"
					onclick={saveCurrent}
					disabled={prompts.saving || Boolean(prompts.loadError)}
				>
					＋ Enregistrer le message en cours
				</button>
			{/if}

			{#if prompts.items.length > 5}
				<input
					class="p-filter"
					bind:value={promptFilter}
					placeholder="Filtrer…"
					aria-label="Filtrer les prompts"
				/>
			{/if}

			<div class="p-list">
				{#each promptMatches as prompt (prompt.id)}
					<div class="p-row">
						<button class="p-use" onclick={() => insert(prompt.text)}>
							<span class="p-title">{prompt.title}</span>
							<!-- A one-line prompt IS its title: printing it twice says nothing. -->
							{#if oneLine(prompt.text) !== prompt.title}
								<span class="p-body">{oneLine(prompt.text)}</span>
							{/if}
						</button>
						<button
							class="p-del"
							onclick={() => prompts.remove(prompt.id)}
							disabled={prompts.saving}
							aria-label="Supprimer ce prompt"><Icon name="close" size={12} /></button
						>
					</div>
				{/each}

				{#if prompts.loadError}
					<!-- Never "Chargement…" here: a failed load is not a slow one, and
					     saving on top of a library we could not read would replace it. -->
					<p class="p-none p-fail">
						La bibliothèque n'a pas pu être chargée, l'enregistrement est donc
						bloqué pour ne rien effacer.<br />{prompts.loadError}
					</p>
					<button class="p-retry" onclick={() => prompts.reload()}>Réessayer</button>
				{:else if prompts.items.length === 0}
					<p class="p-none">
						{prompts.loaded
							? 'Aucun prompt enregistré. Écrivez un message, puis enregistrez-le ici pour le retrouver sur tous vos appareils.'
							: 'Chargement…'}
					</p>
				{:else if promptMatches.length === 0}
					<p class="p-none">Aucun prompt ne correspond.</p>
				{/if}
			</div>
		</div>
	{/if}

	{#if paletteOpen && !promptsOpen && paletteMatches.length}
		<!-- A listbox driven from the field below: the rows are options a script
		     walks with the arrows, never Tab stops in front of the way out. -->
		<div
			class="palette"
			id="composer-skills"
			role="listbox"
			aria-label="Skills"
			bind:this={skillList}
		>
			{#each paletteMatches as skill, i (skill.name)}
				<button
					role="option"
					aria-selected={i === paletteIndex}
					tabindex="-1"
					id="{SKILL_OPTION_ID}{i}"
					class:sel={i === paletteIndex}
					onclick={() => choose(skill.name)}
				>
					<span class="sk-name">/{skill.name}</span>
					<span class="sk-desc">{skill.description ?? ''}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if attachments.length}
		<div class="attachments">
			{#each attachments as att (att.id)}
				<div class="att">
					<img src={att.dataUrl} alt={att.name} />
					<button
						aria-label="Retirer"
						onclick={() => (attachments = attachments.filter((a) => a.id !== att.id))}
						><Icon name="close" size={11} /></button
					>
				</div>
			{/each}
		</div>
	{/if}

	<div class="row">
		<label class="attach" title="Joindre une image ou un fichier texte">
			<Icon name="paperclip" size={17} />
			<!-- No `accept`: images are attached, anything textual is inlined into
			     the message, and on iOS a narrow filter is what hides the Files
			     app behind the photo library. -->
			<input
				type="file"
				multiple
				aria-label="Joindre une image ou un fichier texte"
				onchange={(e) => {
					const input = e.currentTarget;
					if (input.files) addFiles(input.files);
					input.value = '';
				}}
			/>
		</label>

		<button
			class="attach prompt-btn"
			class:on={promptsOpen}
			bind:this={promptTrigger}
			onclick={(event) => {
				// Safari does not focus a clicked button; without this the next
				// Escape would be typed at <body> and reach the page handler.
				event.currentTarget.focus();
				togglePrompts();
			}}
			onkeydown={onPromptKeydown}
			title="Prompts enregistrés"
			aria-label="Prompts enregistrés"
			aria-haspopup="true"
			aria-expanded={promptsOpen}><Icon name="bookmark" size={17} /></button
		>

		<textarea
			bind:this={textarea}
			bind:value={text}
			oninput={onInput}
			onkeydown={onKeydown}
			onpaste={onPaste}
			rows="1"
			aria-label="Message à Yadai"
			aria-controls={paletteOpen && paletteMatches.length ? 'composer-skills' : undefined}
			aria-activedescendant={paletteOpen && paletteMatches[paletteIndex]
				? `${SKILL_OPTION_ID}${paletteIndex}`
				: undefined}
			placeholder={chat.streaming
				? 'Yadai travaille…'
				: narrow
					? 'Écrire à Yadai…'
					: 'Écrire à Yadai…  (/ pour les skills)'}
		></textarea>

		{#if chat.streaming}
			<!-- "Détacher", not "Stop": Hermes cannot interrupt a Sessions API
			     turn, so this only stops watching it. -->
			<button
				class="send stop"
				onclick={() => chat.stop()}
				aria-label="Arrêter l'affichage"
				title="Arrêter l'affichage (l'agent termine en arrière-plan)"
				><Icon name="stop" size={15} /></button
			>
		{:else}
			<button
				class="send"
				onclick={submit}
				disabled={!text.trim() && attachments.length === 0}
				aria-label="Envoyer le message"
				title="Envoyer"><Icon name="arrowUp" size={19} /></button
			>
		{/if}
	</div>
</div>

<style>
	/* The floating bar. It is the one control that is always on screen, so it
	   is the one thing allowed to hover over the thread rather than sit in it:
	   detached from the panel's edge, no stroke, and lifted by the deepest of
	   the three elevations. */
	.composer {
		position: relative;
		margin: 0 auto;
		width: 100%;
		max-width: 780px;
		padding: 10px 10px 10px 14px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
	}
	.composer.dragging {
		background: var(--accent-soft);
		box-shadow: var(--shadow-float), 0 0 0 2px var(--accent);
	}
	/* The textarea has no ring of its own — a box inside a box — so the box
	   itself is what says the keyboard is writing here. With the stroke gone
	   that is a second shadow rather than a border colour. */
	.composer:focus-within {
		box-shadow: var(--shadow-float), 0 0 0 2px var(--focus);
	}
	.row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}
	textarea {
		flex: 1;
		min-height: 32px;
		max-height: 260px;
		padding: 9px 4px;
		background: none;
		border: none;
		outline: none;
		resize: none;
		line-height: 1.5;
	}
	/* Round chips, like every secondary action in this design: a filled circle
	   rather than a bare glyph, so the row reads as a row of controls. */
	.attach {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--bg-sunken);
		cursor: pointer;
		font-size: 16px;
		opacity: 0.75;
	}
	.attach:hover {
		opacity: 1;
		background: var(--bg-hover);
	}
	/* Hidden, but still a stop for the keyboard: `display: none` took the file
	   input out of the tab order, and its label cannot take focus in its place
	   — attaching an image was mouse-only. */
	.attach input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
	.attach:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.prompt-btn {
		line-height: 1;
	}
	.prompt-btn.on {
		opacity: 1;
		background: var(--bg-hover);
	}
	/* The one prominent circle of the screen — the design's primary button,
	   sitting proud of the bar it belongs to. Sending is the positive action
	   here, so it wears the second accent rather than the first. */
	.send {
		flex: 0 0 auto;
		width: 46px;
		height: 46px;
		border-radius: 50%;
		background: var(--accent-2);
		color: var(--accent-2-ink);
		box-shadow: var(--shadow-card);
		font-size: 18px;
		line-height: 1;
		transition: transform 0.14s ease;
	}
	.send:not(:disabled):hover {
		transform: translateY(-1px);
	}
	.send:disabled {
		opacity: 0.35;
		box-shadow: none;
		cursor: default;
	}
	.send.stop {
		background: var(--bg-sunken);
		color: var(--text-muted);
		box-shadow: none;
		font-size: 12px;
	}
	@media (prefers-reduced-motion: reduce) {
		.send {
			transition: none;
		}
		.send:not(:disabled):hover {
			transform: none;
		}
	}
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
		padding: 4px 4px 9px;
	}
	.att {
		position: relative;
	}
	.att img {
		width: 58px;
		height: 58px;
		object-fit: cover;
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-card);
	}
	.att button {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 19px;
		height: 19px;
		font-size: 10px;
		border-radius: 50%;
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		color: var(--text-muted);
	}
	.notice {
		margin: 0 4px 8px;
		padding: 7px 12px;
		font-size: 12.5px;
		border-radius: var(--radius-card);
		background: var(--accent-soft);
		color: var(--text-muted);
	}
	.palette {
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: calc(100% + 8px);
		display: flex;
		flex-direction: column;
		max-height: 260px;
		overflow-y: auto;
		padding: 8px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-float);
	}
	.palette button {
		display: flex;
		gap: 10px;
		align-items: baseline;
		padding: 10px 13px;
		border-radius: var(--radius-card);
		text-align: left;
	}
	.palette button.sel,
	.palette button:hover {
		background: var(--bg-hover);
	}
	/* Saved prompts ------------------------------------------------------- */
	.pscrim {
		position: fixed;
		inset: 0;
		z-index: 5;
	}
	.palette.prompts {
		z-index: 6;
		max-height: min(340px, 55vh);
	}
	.p-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px 6px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.palette .p-x {
		padding: 0 4px;
		color: var(--text-faint);
	}
	.palette .p-save {
		display: block;
		width: 100%;
		font-size: 13px;
		color: var(--accent);
	}
	.palette .p-save:disabled {
		opacity: 0.5;
	}
	.p-filter {
		margin: 4px 6px 2px;
		padding: 9px 14px;
		background: var(--bg-sunken);
		border: none;
		border-radius: var(--radius-pill);
		font-size: 13px;
	}
	.p-list {
		overflow-y: auto;
	}
	.p-row {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.palette .p-use {
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		align-items: stretch;
	}
	.p-title {
		font-size: 13.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.p-body {
		font-size: 12px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.palette .p-del {
		flex: 0 0 auto;
		padding: 6px 8px;
		font-size: 11px;
		color: var(--text-faint);
	}
	.palette .p-del:hover {
		color: var(--danger);
	}
	.p-none {
		margin: 0;
		padding: 12px 10px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.p-fail {
		color: var(--danger);
	}
	.palette .p-retry {
		display: block;
		width: 100%;
		font-size: 13px;
		color: var(--accent);
	}
	/* A phone has ~250px of usable width in this bar once the three round
	   controls are out; giving them desktop sizes there pushes the placeholder
	   onto a second line and makes an empty composer two rows tall. */
	@media (max-width: 820px) {
		.composer {
			padding: 7px 7px 7px 10px;
		}
		.row {
			gap: 5px;
		}
		/* 44px, like every other touch target in this app — measured at 36px
		   before, which is below the size a thumb can be asked to hit. The
		   short placeholder above is what buys the width back. */
		.attach,
		.send {
			width: 44px;
			height: 44px;
		}
		.send {
			font-size: 17px;
		}
		textarea {
			font-size: 14px;
			padding: 11px 4px;
		}
		/* A popup row is a tap target like every other one in this app.
		   Measured at 414×896 before: the library's close button was 22×14, and
		   its "supprimer" 28×24 pressed against a 332px-wide row that *uses*
		   the prompt — a mis-tap threw a saved prompt away instead of inserting
		   it. Skill rows measured 42px.

		   `flex: none` because `.palette` is a flex column, where a
		   `min-height` on a child becomes an imposed height instead of a
		   floor (same trap as the model picker, CLAUDE.md §33). */
		.palette button {
			flex: none;
			min-height: 44px;
		}
		.palette .p-x,
		.palette .p-del {
			min-width: 44px;
			justify-content: center;
		}
		.p-filter {
			min-height: 44px;
		}
	}
	.sk-name {
		flex: 0 0 auto;
		font-family: ui-monospace, Menlo, monospace;
		font-size: 13px;
		color: var(--accent);
	}
	.sk-desc {
		flex: 1;
		min-width: 0;
		font-size: 12.5px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
