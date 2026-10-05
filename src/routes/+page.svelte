<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onDestroy, onMount, tick } from 'svelte';
	import AgentPicker from '$lib/components/AgentPicker.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import Message from '$lib/components/Message.svelte';
	import ModelPicker from '$lib/components/ModelPicker.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { agents } from '$lib/stores/agents.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { prompts } from '$lib/stores/prompts.svelte';
	import { push } from '$lib/stores/push.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { toasts } from '$lib/stores/toast.svelte';
	import { read, readJSON, write, writeJSON } from '$lib/client/storage';
	import { hasMod, modKey } from '$lib/client/platform';
	import { usageSummary } from '$lib/sessions';
	import { agentColor, directReports } from '$lib/agents';
	import { turnAnnouncement } from '$lib/a11y';
	import { lazyComponent } from '$lib/client/lazy.svelte';

	let sidebarOpen = $state(false);
	let sidebarCollapsed = $state(false);
	let paletteOpen = $state(false);
	let statusOpen = $state(false);
	let skillsOpen = $state(false);
	let providersOpen = $state(false);
	let jobsOpen = $state(false);
	let agentsOpen = $state(false);
	let shortcutsOpen = $state(false);
	let themeOpen = $state(false);
	let settingsOpen = $state(false);
	let approvalsOpen = $state(false);
	let narrow = $state(false);
	/** The sidebar instance, so the settings panel can switch its list. */
	let sidebar = $state<{ showList: (v: 'live' | 'archived' | 'trash') => void } | null>(null);
	/** How much of the layout viewport the soft keyboard is covering. */
	let keyboard = $state(0);

	let scroller = $state<HTMLDivElement | null>(null);
	/** Autoscroll only while already at the bottom, so scrolling up to read
	 *  mid-stream isn't yanked back down. */
	let pinnedToBottom = $state(true);
	let composer = $state<Composer | null>(null);

	/**
	 * The settings panels, fetched on first open rather than at boot.
	 *
	 * None of them is on screen when the app starts, yet statically imported
	 * they were the biggest part of the page bundle — parsed and compiled on
	 * the Pi's CPU before the first message could be painted. Their own
	 * `$effect(() => { if (open) … })` already gates every fetch they do, so
	 * mounting them late changes nothing but when the code arrives.
	 */
	const panels = {
		status: lazyComponent(() => import('$lib/components/StatusPanel.svelte')),
		jobs: lazyComponent(() => import('$lib/components/JobsPanel.svelte')),
		agents: lazyComponent(() => import('$lib/components/AgentsPanel.svelte')),
		skills: lazyComponent(() => import('$lib/components/SkillsPanel.svelte')),
		providers: lazyComponent(() => import('$lib/components/ProvidersPanel.svelte')),
		theme: lazyComponent(() => import('$lib/components/ThemePanel.svelte')),
		settings: lazyComponent(() => import('$lib/components/SettingsPanel.svelte')),
		approvals: lazyComponent(() => import('$lib/components/ApprovalsPanel.svelte')),
		shortcuts: lazyComponent(() => import('$lib/components/Shortcuts.svelte'))
	};

	/** A chunk that cannot be fetched must say so, not leave a dead button. */
	function reveal(panel: { load: () => Promise<void> }) {
		void panel.load().catch(() => toasts.error("Ce panneau n'a pas pu être chargé. Réessayez."));
	}

	$effect(() => {
		if (statusOpen) reveal(panels.status);
		if (jobsOpen) reveal(panels.jobs);
		if (agentsOpen) reveal(panels.agents);
		if (skillsOpen) reveal(panels.skills);
		if (providersOpen) reveal(panels.providers);
		if (themeOpen) reveal(panels.theme);
		if (shortcutsOpen) reveal(panels.shortcuts);
		if (settingsOpen) reveal(panels.settings);
		if (approvalsOpen) reveal(panels.approvals);
	});

	const SUGGESTIONS = [
		"Quel est l'état du Raspberry Pi (CPU, RAM, disque) ?",
		'Résume les nouveautés de ma veille technique du jour.',
		'Cherche les prochains trains pour Tel Aviv.',
		'Liste les conteneurs Docker qui tournent et leur santé.'
	];

	onMount(() => {
		sidebarCollapsed = readJSON('yadai-sidebar-collapsed', false);

		const mq = window.matchMedia('(max-width: 820px)');
		narrow = mq.matches;
		const onChange = (e: MediaQueryListEvent) => {
			narrow = e.matches;
			// A drawer left open while the window grows would become a column
			// with a scrim still over the page — and an Escape that no longer
			// means "close me". It stops being a drawer, so it closes.
			if (!narrow) sidebarOpen = false;
		};
		mq.addEventListener('change', onChange);

		/**
		 * Keep the composer above the iOS keyboard.
		 *
		 * `interactive-widget=resizes-visual` is ignored in standalone mode, so
		 * in an installed PWA the layout viewport keeps its full height and the
		 * keyboard simply covers the bottom of the page — composer included.
		 * The visual viewport is the only thing that reports the real, usable
		 * area, hence this rather than a media query.
		 */
		const vv = window.visualViewport;
		const onViewport = () => {
			if (!vv) return;
			const hidden = window.innerHeight - vv.height - vv.offsetTop;
			// Small deltas are browser chrome (the Safari toolbar), not a keyboard.
			keyboard = hidden > 24 ? Math.round(hidden) : 0;
			if (pinnedToBottom) tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
		};
		vv?.addEventListener('resize', onViewport);
		vv?.addEventListener('scroll', onViewport);

		void boot();

		return () => {
			mq.removeEventListener('change', onChange);
			vv?.removeEventListener('resize', onViewport);
			vv?.removeEventListener('scroll', onViewport);
		};
	});

	async function boot() {
		// Load the saved prompts alongside the session list so the command
		// palette can offer them right away; a failure here is silent.
		void prompts.ensureLoaded();
		// The roster decorates the sidebar and the header, so it is wanted as
		// early as the session list. A failure here is silent on purpose — the
		// session list already reports an unreachable server — but it is NOT
		// harmless: the store records it, and the picker, the panel and the job
		// form read `agents.loadError` rather than mistake an unread roster for
		// an empty team.
		void agents.ensureLoaded();
		// Not for the settings panel — this is what starts reporting whether the
		// app is on screen, which decides if a finished turn notifies.
		void push.init();
		await chat.init();
		// ?s=<id> deep-links a conversation; otherwise resume the last one
		// that was open, like reopening Claude.ai.
		const wanted = new URLSearchParams(location.search).get('s') ?? read('yadai-last-session');
		const target = chat.sessions.find((s) => s.id === wanted) ?? chat.sessions[0];
		if (target) await chat.openSession(target.id);
	}

	onDestroy(() => {
		if (flashTimer) clearTimeout(flashTimer);
		chat.dispose();
	});

	$effect(() => {
		if (chat.sessionId) write('yadai-last-session', chat.sessionId);
	});

	function onScroll() {
		if (!scroller) return;
		const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		pinnedToBottom = gap < 90;
	}

	$effect(() => {
		// Re-runs on every token: cheap enough, and keeps the view glued.
		void chat.messages.at(-1)?.content;
		void chat.messages.length;
		if (!pinnedToBottom) return;
		tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	});

	/**
	 * Scroll to a message the palette found, and mark it for a moment.
	 *
	 * The excerpt says what was found; this says where. The flash is what
	 * replaces highlighting the passage inside the bubble itself, which would
	 * mean rewriting the sanitised markdown a debounced renderer owns.
	 */
	let flashId = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	async function jumpToMessage(id: string, sessionId?: string) {
		// Leaving the bottom by hand: without this, a turn still streaming would
		// pull the view back down before the smooth scroll has settled. Set
		// before the transcript loads, or the arriving messages glue the view
		// to the bottom the moment they render.
		pinnedToBottom = false;
		// A hit from the cross-conversation search names a thread that is not
		// open yet. The ids match because the server grouped the transcript with
		// the very same `groupTranscript` that renders it here.
		if (sessionId && sessionId !== chat.sessionId) await chat.openSession(sessionId);
		flashId = id;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashId = null), 2400);
		await tick();
		for (const node of scroller?.querySelectorAll('[data-mid]') ?? []) {
			if (node.getAttribute('data-mid') !== id) continue;
			node.scrollIntoView({ block: 'center', behavior: 'smooth' });
			return;
		}
	}

	/**
	 * Load the page before the window, without losing the reader's place.
	 *
	 * Prepending content moves everything below it down, so the distance from
	 * the *bottom* is what gets held: the browser keeps `scrollTop`, which
	 * would otherwise jump the view up by the height of the arriving page. A
	 * finished message renders in one synchronous pass (`Markdown.svelte`), so
	 * one `tick()` is enough for the new heights to be real.
	 */
	async function loadOlder() {
		if (!scroller) return;
		// The button is at the top of the thread, but a short conversation can
		// still count as pinned — and the autoscroll effect would then yank the
		// view to the bottom the moment the older page renders.
		pinnedToBottom = false;
		const fromBottom = scroller.scrollHeight - scroller.scrollTop;
		await chat.loadOlderHistory();
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - fromBottom;
	}

	function scrollToBottom() {
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
		pinnedToBottom = true;
	}

	/** Two modals must never stack: the status panel steps aside. */
	function openJobsFromStatus() {
		statusOpen = false;
		jobsOpen = true;
	}

	/**
	 * A settings panel opened from the sidebar replaces it.
	 *
	 * On a phone the sidebar is a drawer over the thread, so the two would
	 * otherwise stack — a dialog on top of a dialog, each trapping Tab. On a
	 * wide screen the sidebar is a column and closing it is a no-op.
	 */
	function openFromSidebar(open: () => void) {
		open();
		sidebarOpen = false;
	}

	function toggleCollapse() {
		sidebarCollapsed = !sidebarCollapsed;
		writeJSON('yadai-sidebar-collapsed', sidebarCollapsed);
	}

	async function exportMarkdown() {
		const text = chat.toMarkdown();
		try {
			await navigator.clipboard.writeText(text);
			toasts.success('Conversation copiée en markdown.');
		} catch {
			// Clipboard is blocked outside a secure context or without a user
			// gesture on some browsers — fall back to a download.
			const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
			const a = document.createElement('a');
			a.href = url;
			a.download = `${chat.current?.title || 'conversation'}.md`;
			a.click();
			URL.revokeObjectURL(url);
		}
	}

	let mod = $state('Ctrl');
	$effect(() => {
		mod = modKey();
	});

	const commands = $derived([
		{ id: 'new', label: 'Nouvelle discussion', hint: `${mod} ⇧O`, run: () => chat.newSession() },
		{ id: 'status', label: 'État du système', hint: `${mod} /`, run: () => (statusOpen = true) },
		{ id: 'skills', label: 'Modifier les skills', run: () => (skillsOpen = true) },
		{ id: 'agents', label: "Équipe d'agents", run: () => (agentsOpen = true) },
		{ id: 'jobs', label: 'Tâches planifiées', run: () => (jobsOpen = true) },
		{ id: 'providers', label: 'Providers (clés API et comptes)', run: () => (providersOpen = true) },
		{ id: 'export', label: 'Exporter la conversation (markdown)', run: exportMarkdown },
		{ id: 'reload', label: 'Recharger la conversation', run: () => chat.reload() },
		...(chat.sessionId
			? [{ id: 'fork', label: 'Brancher la conversation', run: () => chat.forkSession(chat.sessionId!) }]
			: []),
		...(chat.canResend ? [{ id: 'resend', label: 'Renvoyer le dernier message', run: () => chat.resend() }] : []),
		// One entry per saved prompt: ⌘K then a few letters is the fastest way
		// to reuse one on the desktop.
		...prompts.items.map((p) => ({
			id: `prompt:${p.id}`,
			label: `Prompt : ${p.title}`,
			run: () => composer?.insert(p.text)
		})),
		{ id: 'appearance', label: 'Apparence (palette et accents)', run: () => (themeOpen = true) },
		{ id: 'theme', label: 'Basculer le thème clair / sombre', run: () => theme.toggleMode() },
		{ id: 'shortcuts', label: 'Raccourcis clavier', hint: '?', run: () => (shortcutsOpen = true) }
	]);

	function onKeydown(event: KeyboardEvent) {
		// The skills, providers, jobs, agents and theme panels are modal and own
		// their own Escape while open; letting these shortcuts through would
		// fire behind them.
		if (skillsOpen || providersOpen || jobsOpen || agentsOpen || themeOpen) return;
		const meta = hasMod(event);
		const target = event.target as HTMLElement | null;
		const typing =
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target?.isContentEditable;

		if (meta && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			paletteOpen = !paletteOpen;
			return;
		}
		if (meta && event.shiftKey && event.key.toLowerCase() === 'o') {
			event.preventDefault();
			chat.newSession();
			return;
		}
		if (meta && event.key === '/') {
			event.preventDefault();
			statusOpen = !statusOpen;
			return;
		}
		if (event.key === 'Escape') {
			if (paletteOpen || statusOpen || shortcutsOpen) {
				paletteOpen = statusOpen = shortcutsOpen = false;
			} else if (sidebarOpen) {
				// On a narrow window the drawer covers the thread and traps Tab:
				// Escape is the way out, as it is for every other modal surface.
				sidebarOpen = false;
			} else if (chat.streaming) {
				chat.stop();
			}
			return;
		}
		// Bare keys only when not typing, so "?" in a message stays a "?".
		if (typing) return;
		if (event.key === '?') {
			event.preventDefault();
			shortcutsOpen = true;
		} else if (event.key === '/') {
			event.preventDefault();
			composer?.focus();
		}
	}

	/**
	 * Id of the assistant turn this tab has actually watched stream.
	 *
	 * Gate for the live region below: without it, opening a conversation would
	 * announce "Réponse terminée." about the last line of a transcript loaded
	 * from history, which said nothing about anything the user just did. A
	 * message only becomes announceable once it has been seen streaming here,
	 * so a reload — which replaces every message with a fresh id — goes quiet
	 * again.
	 */
	let liveTurnId = $state<string | null>(null);
	$effect(() => {
		const last = chat.messages.at(-1);
		if (last?.streaming) liveTurnId = last.id;
	});
	let announcement = $derived.by(() => {
		const last = chat.messages.at(-1);
		return last && last.id === liveTurnId ? turnAnnouncement(last) : '';
	});

	let title = $derived(chat.current?.title || 'Yadai');
	let usage = $derived(usageSummary(chat.current));
	let activeAgent = $derived(agents.byId(chat.activeAgentId));
	let activeTeam = $derived(activeAgent ? directReports(agents.items, activeAgent) : []);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app" style="--keyboard: {keyboard}px">
	<Sidebar
		bind:this={sidebar}
		open={sidebarOpen}
		drawer={narrow}
		collapsed={sidebarCollapsed && !narrow}
		onclose={() => (sidebarOpen = false)}
		ontoggleCollapse={toggleCollapse}
		onopenSettings={() => openFromSidebar(() => (settingsOpen = true))}
		onopenStatus={() => openFromSidebar(() => (statusOpen = true))}
	/>

	{#if sidebarOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="scrim" onclick={() => (sidebarOpen = false)}></div>
	{/if}

	<main>
		<header>
			<button class="burger" onclick={() => (sidebarOpen = true)} aria-label="Discussions">
				<Icon name="menu" size={20} />
			</button>
			<div class="heading">
				<h1>{title}</h1>
				{#if usage && !narrow}<span class="usage" title="tokens entrée / sortie et coût estimé"
						>{usage}</span
					>{/if}
			</div>
			<div class="head-actions">
				<button
					class="icon"
					onclick={() => (paletteOpen = true)}
					aria-label="Rechercher un message, une conversation, une action (⌘K)"
				>
					<Icon name="search" />
				</button>
				<AgentPicker onmanage={() => (agentsOpen = true)} />
				<ModelPicker />
				<!-- Not on a phone: five controls beside the title left it three
				     characters wide. Apparence is in the drawer's footer and in
				     the ⌘K palette, both one tap away; the name of the
				     conversation you are reading has nowhere else to go. -->
				<button class="icon theme" onclick={() => (themeOpen = true)} aria-label="Apparence">
					<Icon name="contrast" />
				</button>
			</div>
		</header>

		{#if chat.connected === false}
			<div class="banner" role="alert">
				<span><Icon name="warning" size={15} /> Yadai est injoignable — nouvelle tentative en cours.</span>
				<button onclick={() => chat.refreshHealth()}>Réessayer</button>
			</div>
		{/if}

		<!-- The turn's progress, for anyone who cannot see the caret blink or the
		     tool steps appear. Phase only, never the answer's text. -->
		<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

		<div class="scroll" bind:this={scroller} onscroll={onScroll}>
			<div class="thread">
				{#if chat.loadingHistory}
					<p class="status">Chargement…</p>
				{:else if chat.messages.length === 0}
					<div class="welcome">
						<!-- The hero card: the one saturated surface of the app, carrying
						     who you are about to talk to. Its gradient runs from the user
						     bubble toward the palette's deepest tone, which is the one
						     range where white text is guaranteed readable at both ends
						     (`ensureContrast` already deepened it for exactly that). -->
						<div class="hero">
							<span class="orb orb-a"></span>
							<span class="orb orb-b"></span>
							<h2>{activeAgent ? activeAgent.name : 'Yadai'}</h2>
							<p>
								{#if activeAgent}
									{activeAgent.role || 'Agent personnalisé.'}
								{:else}
									Agent complet — terminal, navigateur, mémoire, skills et serveurs MCP —
									exécuté sur le Raspberry&nbsp;Pi.
								{/if}
							</p>
							{#if chat.toolCount > 0}
								<p class="hero-meta">
									{chat.toolCount} outils
									{#if chat.mcpTools.length}· {chat.mcpTools.length} via MCP{/if}
									{#if chat.skills.length}· {chat.skills.length} skills{/if}
								</p>
							{/if}
						</div>

						<!-- The sheet rides up over the hero, the way the content card does
						     on the screen this design follows. -->
						<div class="sheet">
						{#if agents.items.length > 0}
							<div class="who">
								{#each agents.items as agent (agent.id)}
									<button
										class="agent-chip"
										class:sel={agent.id === chat.activeAgentId}
										style="--agent: {agentColor(agent)}"
										title={agent.role}
										onclick={() => chat.setAgent(agent.id)}
									>
										<span class="dot"></span>{agent.name}
									</button>
								{/each}
								<button
									class="agent-chip"
									class:sel={!chat.activeAgentId}
									onclick={() => chat.setAgent('')}>Sans agent</button
								>
								<button class="agent-chip ghost" onclick={() => (agentsOpen = true)}>＋ Gérer</button>
							</div>
							{#if activeTeam.length > 0}
								<p class="team">
									Chef d'équipe : peut confier du travail à {activeTeam
										.map((a) => a.name)
										.join(', ')} via <code>delegate_task</code>.
								</p>
							{/if}
						{/if}

						<p class="lead">Pour commencer</p>
						<div class="chips">
							{#each SUGGESTIONS as suggestion (suggestion)}
								<button onclick={() => chat.send(suggestion)}>{suggestion}</button>
							{/each}
						</div>
						</div>
					</div>
				{/if}

				<!-- Upstream hands back at most 500 rows per read, and the window
				     this thread shows is the NEWEST one. Past that ceiling the
				     start of the conversation is a page away, not lost. -->
				{#if chat.olderHistory && !chat.loadingHistory}
					<div class="older">
						<button onclick={loadOlder} disabled={chat.loadingOlder}>
							<Icon name="arrowUp" />
							{chat.loadingOlder ? 'Chargement…' : 'Charger les messages plus anciens'}
						</button>
						<p>
							Les plus récents sont affichés : cette conversation est trop longue pour tenir
							en une seule lecture.
						</p>
					</div>
				{/if}

				{#each chat.messages as message (message.id)}
					<Message
						{message}
						flash={message.id === flashId}
						onfork={message.role === 'assistant' && chat.sessionId
							? () => chat.forkSession(chat.sessionId!)
							: undefined}
						onreload={() => chat.reload()}
						onresend={message.role === 'assistant' && chat.canResend ? () => chat.resend() : undefined}
					/>
				{/each}
			</div>
		</div>

		{#if !pinnedToBottom && chat.messages.length > 0}
			<button class="to-bottom" onclick={scrollToBottom} aria-label="Aller en bas">
				<Icon name="arrowDown" />
			</button>
		{/if}

		<div class="composer-wrap">
			<Composer bind:this={composer} {narrow} />
			<p class="disclaimer">
				<!-- Two sentences do not fit on one phone line, and a wrapped
				     disclaimer steals a row from the thread. The half that is a
				     warning stays; the half that says where it runs is on the
				     status panel anyway. -->
				{#if !narrow}Les outils s'exécutent sur le Pi.{/if} Vérifiez les commandes sensibles.
				<button class="link" onclick={() => (shortcutsOpen = true)}>Raccourcis</button>
			</p>
		</div>
	</main>
</div>

<CommandPalette
	open={paletteOpen}
	onclose={() => (paletteOpen = false)}
	{commands}
	onjump={jumpToMessage}
/>

<!-- Each panel appears in the tree only once its chunk has landed; from then on
     it stays, so reopening is as immediate as it was before. -->
{#if panels.status.current}
	{@const StatusPanel = panels.status.current}
	<StatusPanel open={statusOpen} onclose={() => (statusOpen = false)} onopenJobs={openJobsFromStatus} />
{/if}
{#if panels.jobs.current}
	{@const JobsPanel = panels.jobs.current}
	<JobsPanel open={jobsOpen} onclose={() => (jobsOpen = false)} />
{/if}
{#if panels.agents.current}
	{@const AgentsPanel = panels.agents.current}
	<AgentsPanel open={agentsOpen} onclose={() => (agentsOpen = false)} />
{/if}
{#if panels.skills.current}
	{@const SkillsPanel = panels.skills.current}
	<SkillsPanel open={skillsOpen} onclose={() => (skillsOpen = false)} />
{/if}
{#if panels.providers.current}
	{@const ProvidersPanel = panels.providers.current}
	<ProvidersPanel open={providersOpen} onclose={() => (providersOpen = false)} />
{/if}
{#if panels.theme.current}
	{@const ThemePanel = panels.theme.current}
	<ThemePanel open={themeOpen} onclose={() => (themeOpen = false)} />
{/if}
{#if panels.shortcuts.current}
	{@const Shortcuts = panels.shortcuts.current}
	<Shortcuts open={shortcutsOpen} onclose={() => (shortcutsOpen = false)} />
{/if}
{#if panels.approvals.current}
	{@const ApprovalsPanel = panels.approvals.current}
	<ApprovalsPanel open={approvalsOpen} onclose={() => (approvalsOpen = false)} />
{/if}
{#if panels.settings.current}
	{@const SettingsPanel = panels.settings.current}
	<SettingsPanel
		open={settingsOpen}
		onclose={() => (settingsOpen = false)}
		onopenStatus={() => (statusOpen = true)}
		onopenSkills={() => (skillsOpen = true)}
		onopenProviders={() => (providersOpen = true)}
		onopenJobs={() => (jobsOpen = true)}
		onopenAgents={() => (agentsOpen = true)}
		onopenTheme={() => (themeOpen = true)}
		onopenShortcuts={() => (shortcutsOpen = true)}
		onopenApprovals={() => (approvalsOpen = true)}
		onshowArchived={() => sidebar?.showList('archived')}
		onshowTrash={() => sidebar?.showList('trash')}
	/>
{/if}

<style>
	/* Panels float: the page background shows between them, which is what
	   gives the layout its depth. On a phone that margin is just lost width,
	   so the media query below takes it all back. */
	.app {
		display: flex;
		gap: var(--gap-panel);
		height: 100dvh;
		padding: var(--gap-panel);
		padding-top: max(var(--gap-panel), env(safe-area-inset-top));
		padding-bottom: max(var(--gap-panel), env(safe-area-inset-bottom));
		overflow: hidden;
	}
	/* The thread's ground is the *sunken* surface, not the raised one. That is
	   the whole move of this design: cards are told apart from the page by
	   being lighter and lifted, never by a line drawn around them — so the
	   page has to be the darker of the two for a card to have anywhere to
	   rise from. */
	main {
		position: relative;
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		background: var(--bg-sunken);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow);
		overflow: hidden;
	}
	/* No bar and no rule: a big title standing on the page, with the controls
	   trailing it. The divider was the last stroke in the layout. */
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 22px 10px;
	}
	.heading {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	h1 {
		margin: 0;
		font-size: 21px;
		font-weight: 700;
		letter-spacing: -0.01em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.usage {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-faint);
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	/* Round chips, the same shape the composer's secondary actions wear. */
	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: var(--bg-raised);
		color: var(--text-muted);
		border-radius: 50%;
		box-shadow: var(--shadow-card);
		font-size: 15px;
		line-height: 1;
	}
	.icon:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.burger {
		display: none;
		padding: 2px 6px;
		font-size: 17px;
		color: var(--text-muted);
	}
	.banner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		margin: 4px 16px 0;
		padding: 10px 16px;
		border-radius: var(--radius-card);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 13px;
	}
	.banner button {
		padding: 5px 13px;
		border: 1px solid currentColor;
		border-radius: var(--radius-pill);
		font-size: 12.5px;
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.thread {
		max-width: 780px;
		margin: 0 auto;
		padding: 14px 16px 8px;
	}
	.to-bottom {
		position: absolute;
		left: 50%;
		bottom: calc(112px + var(--keyboard, 0px));
		transform: translateX(-50%);
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--bg-raised);
		box-shadow: var(--shadow-float);
		color: var(--text-muted);
		font-size: 15px;
	}
	.to-bottom:hover {
		color: var(--text);
	}
	/* `--keyboard` is what the visual viewport says the soft keyboard is
	   covering; see the listener in onMount. It is 0 on the desktop. */
	.composer-wrap {
		padding: 8px 16px 14px;
		padding-bottom: calc(14px + var(--keyboard, 0px));
	}
	.disclaimer {
		max-width: 780px;
		margin: 6px auto 0;
		text-align: center;
		font-size: 11px;
		color: var(--text-faint);
	}
	.link {
		color: var(--text-faint);
		text-decoration: underline;
		font-size: 11px;
	}
	.link:hover {
		color: var(--text);
	}
	.status {
		text-align: center;
		color: var(--text-faint);
		font-size: 13px;
	}
	/* The page above the window: a raised pill, like every other secondary
	   control of the app, over the sunken thread. */
	.older {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 2px 0 14px;
		text-align: center;
	}
	.older button {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 36px;
		padding: 8px 16px;
		background: var(--bg-raised);
		border-radius: var(--radius-pill);
		box-shadow: var(--shadow-card);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.older button:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text);
	}
	.older button:disabled {
		opacity: 0.6;
	}
	.older p {
		max-width: 420px;
		color: var(--text-faint);
		font-size: 12px;
	}
	.welcome {
		padding: 4vh 0 0;
		color: var(--text-muted);
	}
	.hero {
		position: relative;
		overflow: hidden;
		padding: 26px 26px 46px;
		border-radius: var(--radius-panel);
		/* White is readable at both ends: `--user-bubble` is the accent already
		   deepened until it passes 4.5:1 against white, and the far end only
		   deepens it further toward the palette's darkest tone. */
		background: linear-gradient(142deg, var(--user-bubble) 0%, var(--hero-2) 100%);
		color: var(--user-ink);
		box-shadow: var(--shadow);
	}
	/* The two soft discs of the reference layout: light on the gradient, drawn
	   from the ink already known to sit on it rather than from a new colour. */
	.orb {
		position: absolute;
		border-radius: 50%;
		background: color-mix(in srgb, var(--user-ink) 18%, transparent);
		pointer-events: none;
	}
	.orb-a {
		top: -78px;
		right: -46px;
		width: 200px;
		height: 200px;
	}
	.orb-b {
		top: 44px;
		right: 132px;
		width: 96px;
		height: 96px;
		background: color-mix(in srgb, var(--user-ink) 10%, transparent);
	}
	.welcome h2 {
		position: relative;
		margin: 0 0 8px;
		font-size: 30px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--user-ink);
	}
	.hero > p {
		position: relative;
		max-width: 460px;
		margin: 0;
		font-size: 14px;
		opacity: 0.88;
	}
	.hero-meta {
		position: relative;
		display: inline-block;
		margin-top: 16px !important;
		padding: 5px 13px;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--user-ink) 17%, transparent);
		font-size: 12px !important;
		opacity: 1 !important;
	}
	/* Lifted over the hero, the way the content card overlaps the header on
	   the screen this follows. */
	.sheet {
		position: relative;
		margin: -30px 10px 0;
		padding: 18px 20px 20px;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-card);
	}
	.lead {
		margin: 0 0 10px !important;
		font-size: 11px !important;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--gap-card);
	}
	.chips button {
		padding: 11px 17px;
		min-height: 44px;
		background: var(--bg-sunken);
		border-radius: var(--radius-pill);
		font-size: 13px;
		color: var(--text-muted);
		text-align: left;
	}
	.chips button:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
		margin: 0 0 16px;
	}
	.agent-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 15px;
		min-height: 36px;
		background: var(--bg-sunken);
		border: 1px solid transparent;
		border-radius: var(--radius-pill);
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.agent-chip:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.agent-chip.sel {
		border-color: var(--agent, var(--accent));
		color: var(--text);
	}
	.agent-chip.ghost {
		border-style: dashed;
		border-color: var(--border);
	}
	.agent-chip .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--agent);
	}
	.team {
		margin: 0 0 16px !important;
		font-size: 12px !important;
		color: var(--text-faint);
	}
	.team code {
		font-size: 11.5px;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: var(--scrim);
	}

	/* Phone: full bleed. Floating cards with 14px margins on a 390px screen
	   are just lost width — same colours, same roundness, no gutters. */
	@media (max-width: 820px) {
		.app {
			gap: 0;
			padding: 0;
		}
		main {
			border-radius: 0;
			box-shadow: none;
		}
		header {
			padding: 12px 14px 8px;
			padding-top: max(12px, env(safe-area-inset-top));
		}
		.burger {
			display: block;
			min-width: 44px;
			min-height: 44px;
		}
		.icon {
			width: 40px;
			height: 40px;
		}
		/* The header carries the burger, the title and four controls on 390px.
		   The title is the one thing that must not be the loser: without this
		   it was measured at *zero* pixels wide, squeezed out by the token
		   counter beside it (now hidden here) and by controls that would not
		   shrink. */
		.head-actions {
			flex: 0 0 auto;
		}
		.heading {
			flex: 1 1 auto;
			min-width: 60px;
		}
		.icon.theme {
			display: none;
		}
		h1 {
			font-size: 17px;
		}
		.thread {
			padding: 10px 12px 8px;
		}
		.older button {
			min-height: 44px;
		}
		.hero {
			padding: 22px 20px 44px;
		}
		.welcome h2 {
			font-size: 26px;
		}
		.sheet {
			margin: -30px 4px 0;
			padding: 16px;
		}
		.composer-wrap {
			padding: 6px 10px 10px;
			/* Only one of the two is ever non-zero: the keyboard covers the home
			   indicator while it is up. */
			padding-bottom: calc(10px + max(env(safe-area-inset-bottom), var(--keyboard, 0px)));
		}
		.chips button {
			font-size: 12.5px;
		}
		/* Choosing who you are talking to is a tap like any other: measured at
		   38px before. */
		.agent-chip {
			min-height: 44px;
		}
		/* Inline in a sentence, so it cannot *be* 44px tall — but its hit area
		   can, by padding out and pulling the layout back in. */
		.link {
			padding: 12px 4px;
			margin: -12px 0;
		}
	}
</style>
