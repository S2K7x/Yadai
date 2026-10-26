<script lang="ts">
	import Icon from './Icon.svelte';
	import { dialogFocus, trapTab } from '$lib/client/dialog.svelte';
	import { menuKeydown } from '$lib/client/menu.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { agents } from '$lib/stores/agents.svelte';
	import { drafts } from '$lib/stores/drafts.svelte';
	import { agentColor, agentInitial } from '$lib/agents';
	import { groupSessions, matchesQuery, relativeTime, sessionLabel, activityAt } from '$lib/sessions';
	import { TRASH_DAYS, trashLabel } from '$lib/trash';
	import type { HermesSession } from '$lib/types';

	/** First letter of a conversation's name, for the round thumbnail. */
	const initial = (label: string) => label.trim().charAt(0).toUpperCase() || '·';

	interface Props {
		open: boolean;
		/**
		 * Under 820px the sidebar is not a column but a drawer sliding over the
		 * thread, scrim included — which makes it a modal dialog, with
		 * everything that entails for the keyboard and for VoiceOver.
		 */
		drawer: boolean;
		collapsed: boolean;
		onclose: () => void;
		ontoggleCollapse: () => void;
		/** The one door to everything that is not a conversation. */
		onopenSettings: () => void;
		onopenStatus: () => void;
	}
	let {
		open,
		drawer,
		collapsed,
		onclose,
		ontoggleCollapse,
		onopenSettings,
		onopenStatus
	}: Props = $props();

	let panel = $state<HTMLElement | null>(null);
	/** A drawer that is out and covering the thread: a dialog, not a column. */
	let modal = $derived(drawer && open);

	// Same contract as every settings panel (point 22): focus enters the drawer
	// when it slides out, and goes back to the menu button when it closes.
	dialogFocus(
		() => modal,
		() => panel
	);

	let filter = $state('');
	/** Which of the three lists the column is showing. */
	let view = $state<'live' | 'archived' | 'trash'>('live');
	let showArchived = $derived(view === 'archived');
	let showTrash = $derived(view === 'trash');
	let renaming = $state<string | null>(null);
	let renameValue = $state('');
	let menuFor = $state<string | null>(null);
	/** The ⋯ the open row menu came from, so Escape can hand the focus back. */
	let menuTrigger = $state<HTMLElement | null>(null);

	// The three lists are separate collections, not filters over one: Hermes
	// excludes archived rows from every listing, and the bin is filtered out of
	// them by our own proxy, so `chat.sessions` never holds either kind.
	let source = $derived(
		showTrash ? chat.trashedSessions : showArchived ? chat.archivedSessions : chat.sessions
	);
	let visible = $derived(source.filter((s) => matchesQuery(s, filter)));
	// The bin is ordered by when things were thrown away, so grouping it by the
	// day the conversation was last *used* would sort it by the wrong clock.
	let groups = $derived(
		showTrash
			? [{ key: 'trash', label: 'In the trash', sessions: visible }]
			: groupSessions(visible)
	);

	/**
	 * Switch the column between its three lists.
	 *
	 * Exported because the settings panel is where "Archivées" and "Corbeille"
	 * now live: the panel closes itself and asks the column to change list,
	 * rather than owning a copy of these views.
	 */
	export async function showList(next: 'live' | 'archived' | 'trash') {
		view = next;
		if (next === 'archived') await chat.refreshArchived();
		if (next === 'trash') await chat.refreshTrash();
	}

	async function pick(id: string) {
		await chat.openSession(id);
		onclose();
	}

	/** Escape hands the focus back to the ⋯ the menu came from. */
	function closeMenu(refocus = false) {
		menuFor = null;
		if (refocus && menuTrigger?.isConnected) menuTrigger.focus();
	}

	function startRename(s: HermesSession) {
		renaming = s.id;
		renameValue = s.title ?? '';
		menuFor = null;
	}

	async function commitRename() {
		const id = renaming;
		renaming = null;
		if (id && renameValue.trim()) await chat.renameSession(id, renameValue.trim());
	}

	/**
	 * No confirmation any more: deleting is reversible now, and a modal asking
	 * "are you sure?" for something undoable is friction that teaches people to
	 * click through prompts. The toast's "Annuler" and the bin are the answer.
	 */
	async function deleteToBin(s: HermesSession) {
		closeMenu();
		await chat.deleteSession(s.id);
	}

	/** This one really is final, so this one really does ask. */
	async function confirmPurge(s: HermesSession) {
		closeMenu();
		if (
			confirm(
				`Delete "${sessionLabel(s)}" forever?\n\nThis time the conversation and its transcript will really be erased, with no way back.`
			)
		) {
			await chat.purgeSession(s.id);
		}
	}

	// Clicking anywhere else closes an open row menu.
	function onWindowClick(event: MouseEvent) {
		if (!menuFor) return;
		if (!(event.target as HTMLElement).closest('.row')) menuFor = null;
	}

	/**
	 * Tab must not walk out of the open drawer into the thread behind it.
	 *
	 * Handled on the window rather than on the drawer itself because focus can
	 * legitimately sit on the element the browser is about to leave, and
	 * because as a column — every screen wider than 820px — the sidebar is not
	 * a dialog and must trap nothing at all.
	 *
	 * It also only acts on a Tab pressed *inside* the drawer. A settings panel
	 * opened on top has its own trap, and two traps pulling in opposite
	 * directions is worse than none: the drawer would drag the focus out of the
	 * dialog the user is actually in.
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		if (!modal || !panel || !panel.contains(event.target as Node)) return;
		trapTab(panel, event);
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<!-- Closed, the drawer is still there: parked at `translateX(-100%)` off the
     left edge, but as reachable by Tab and by VoiceOver as if it were on
     screen. `inert` is what makes "off screen" mean "out of reach".

     `tabindex="-1"` is unconditional — it means "focusable by script, not by
     Tab", harmless on the desktop column, and it is what lets the open drawer
     take the focus and be announced by name. -->
<aside
	class="sidebar"
	class:open
	class:collapsed
	bind:this={panel}
	inert={drawer && !open}
	role={modal ? 'dialog' : undefined}
	aria-modal={modal ? 'true' : undefined}
	aria-label={modal ? 'Chats' : undefined}
	tabindex="-1"
>
	{#if collapsed}
		<div class="rail">
			<button class="rail-btn" onclick={ontoggleCollapse} aria-label="Expand chats">
				<Icon name="chevronRight" size={19} />
			</button>
			<button
				class="rail-btn accent"
				onclick={() => chat.newSession()}
				aria-label="New chat"
			>
				<Icon name="plus" size={19} />
			</button>
			<div class="rail-spacer"></div>
			<button class="rail-btn" onclick={onopenSettings} aria-label="Settings">
				<Icon name="settings" size={19} />
			</button>
			<button class="rail-btn" onclick={onopenStatus} aria-label="System status">
				<span class="dot" class:ok={chat.connected === true} class:ko={chat.connected === false}
				></span>
			</button>
		</div>
	{:else}
		<div class="top">
			<button class="new" onclick={async () => { await chat.newSession(); onclose(); }}>
				<Icon name="plus" size={17} /> New chat
			</button>
			<button class="icon-btn collapse" onclick={ontoggleCollapse} aria-label="Collapse">
				<Icon name="chevronLeft" />
			</button>
			<button class="icon-btn close" onclick={onclose} aria-label="Close menu">
				<Icon name="close" />
			</button>
		</div>

		<input
			class="search"
			bind:value={filter}
			placeholder="Search…"
			type="search"
			aria-label="Search chats"
		/>

		<nav class="list">
			{#each groups as group (group.key)}
				<div class="group">{group.label}</div>
				{#each group.sessions as entry (entry.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="row"
						class:bin={showTrash}
						class:active={entry.id === chat.sessionId && !showTrash}
						onkeydown={(event) => {
							if (menuFor !== entry.id) return;
							// Read the panel off the row rather than binding it: only one row
							// menu is ever open, but a `bind:this` inside an {#each} would go
							// through null while the open menu moves from one row to another.
							const panel = event.currentTarget.querySelector<HTMLElement>('.menu');
							if (menuKeydown(panel, event) === 'close') closeMenu(true);
						}}
					>
						{#if renaming === entry.id}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="rename"
								bind:value={renameValue}
								autofocus
								onblur={commitRename}
								onkeydown={(e) => {
									if (e.key === 'Enter') commitRename();
									if (e.key === 'Escape') renaming = null;
								}}
							/>
						{:else if showTrash}
							{@const agent = agents.byId(entry.agent_id)}
							<!-- Not a button: in the bin a row has two explicit answers,
							     and "open" is not one of them. Clicking a deleted
							     conversation to read it would leave the app showing a
							     thread that no list contains. -->
							<div class="entry static" title={entry.preview ?? ''}>
								<span
									class="ava"
									class:agented={!!agent}
									style={agent ? `--agent: ${agentColor(agent)}` : undefined}
									aria-hidden="true">{agent ? agentInitial(agent) : initial(sessionLabel(entry))}</span
								>
								<span class="txt">
									<span class="title">{sessionLabel(entry)}</span>
									<span class="sub">
										<span class="when">{trashLabel(entry.deleted_at ?? 0)}</span>
										{#if agent}<span class="agent" style="--agent: {agentColor(agent)}"
												>· {agent.name}</span
											>{/if}
									</span>
								</span>
							</div>
							<div class="bin-acts">
								<button class="bin-act" onclick={() => chat.restoreSession(entry.id)}>
									<Icon name="restore" size={14} /> Restore
								</button>
								<button class="bin-act danger" onclick={() => confirmPurge(entry)}>
									Delete forever
								</button>
							</div>
						{:else}
							{@const agent = agents.byId(entry.agent_id)}
							{@const draft = drafts.preview(entry.id)}
							<button
								class="entry"
								onclick={() => pick(entry.id)}
								title={draft ? `Draft: ${draft}` : (entry.preview ?? '')}
							>
								<!-- The round thumbnail every row of this design opens with.
								     A conversation has no picture, so it wears its agent's
								     emoji or, failing that, its own first letter. -->
								<span
									class="ava"
									class:agented={!!agent}
									style={agent ? `--agent: ${agentColor(agent)}` : undefined}
									aria-hidden="true">{agent ? agentInitial(agent) : initial(sessionLabel(entry))}</span
								>
								<span class="txt">
									<span class="title">
										{#if entry.parent_session_id}<span class="branch" title="branch"
												><Icon name="branch" size={13} /></span
											>{/if}
										{sessionLabel(entry)}
									</span>
									<span class="sub">
										<span class="when">{relativeTime(activityAt(entry))}</span>
										{#if agent}<span class="agent" style="--agent: {agentColor(agent)}"
												>· {agent.name}</span
											>{/if}
										<!-- A message typed here and never sent is invisible from
										     any other conversation; this is the only thing that
										     says so. -->
										{#if draft}<span class="draft"
												>· <Icon name="pencil" size={12} /> draft</span
											>{/if}
									</span>
								</span>
							</button>
							<button
								class="more"
								aria-label="Actions for “{sessionLabel(entry)}”"
								aria-haspopup="true"
								aria-expanded={menuFor === entry.id}
								onclick={(e) => {
									e.stopPropagation();
									// Safari leaves a clicked button unfocused; Escape would then
									// be typed at <body> and close the whole drawer instead.
									e.currentTarget.focus();
									menuTrigger = e.currentTarget;
									menuFor = menuFor === entry.id ? null : entry.id;
								}}
								><span class="dots" aria-hidden="true">⋯</span></button
							>
						{/if}

						{#if menuFor === entry.id}
							<div class="menu">
								<button onclick={() => startRename(entry)}>Rename</button>
								<button onclick={() => { chat.togglePin(entry.id); closeMenu(true); }}>
									{entry.pinned ? 'Unpin' : 'Pin'}
								</button>
								<button onclick={() => { chat.forkSession(entry.id); closeMenu(); onclose(); }}>
									Branch
								</button>
								<button onclick={() => { chat.toggleArchive(entry.id); closeMenu(true); }}>
									{entry.archived ? 'Unarchive' : 'Archive'}
								</button>
								<button class="danger" onclick={() => deleteToBin(entry)}>Delete</button>
							</div>
						{/if}
					</div>
				{/each}
			{/each}

			{#if visible.length === 0}
				<p class="empty">
					{#if showArchived && chat.loadingArchived}
						Looking for archived conversations…
					{:else if showTrash && chat.loadingTrash}
						Opening the trash…
					{:else if view === 'live' && chat.loadingSessions}
						Loading…
					{:else if filter}
						No results for “{filter}”.
					{:else if showArchived}
						No archived conversations.
					{:else if showTrash}
						The trash is empty.
					{:else}
						No chats yet.
					{/if}
				</p>
			{:else if showArchived && chat.archivedTruncated}
				<p class="empty">
					Only the most recent archived conversations are listed: Yadai cannot enumerate them,
					so they are found one by one.
				</p>
			{:else if showTrash}
				<p class="empty">
					A deleted conversation is kept for {TRASH_DAYS} days before it is erased for good.
					Nothing has been deleted in Yadai yet: restoring it puts it back exactly where it
					was.
				</p>
			{/if}
		</nav>

		<footer>
			{#if view === 'live'}
				<!-- Six emoji buttons wrapped over three ragged rows here. They are
				     one door now; what is behind it is grouped and named in
				     SettingsPanel.svelte. -->
				<button class="settings-btn" onclick={onopenSettings}>
					<Icon name="settings" /> Settings
				</button>
			{:else}
				<button class="settings-btn" onclick={() => showList('live')}>
					<Icon name="chevronLeft" /> Chats
				</button>
			{/if}
			<button class="status" onclick={onopenStatus} title="System status">
				<span class="dot" class:ok={chat.connected === true} class:ko={chat.connected === false}
				></span>
				{#if chat.connected === true}
					Yadai {chat.version}
				{:else if chat.connected === false}
					Offline
				{:else}
					connecting…
				{/if}
			</button>
		</footer>
	{/if}
</aside>

<style>
	.agent {
		color: var(--agent);
	}
	/* A floating panel of its own, not a strip glued to the thread. When
	   collapsed it becomes the dark icon rail — the first column of the
	   design — so the two states swap surface as well as width. */
	.sidebar {
		display: flex;
		flex-direction: column;
		width: 268px;
		flex: 0 0 268px;
		height: 100%;
		background: var(--bg-raised);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow);
		overflow: hidden;
		transition: flex-basis 0.16s ease, width 0.16s ease;
	}
	/* The drawer takes focus when it opens so it is announced by name; a ring
	   drawn around the whole panel is not the signal, the announcement is —
	   same call as the modal card in `Modal.svelte`. */
	.sidebar:focus {
		outline: none;
	}
	.sidebar.collapsed {
		width: var(--rail-width);
		flex-basis: var(--rail-width);
		background: var(--rail);
		border-radius: var(--radius-rail);
	}
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		height: 100%;
		padding: 14px 0;
		color: var(--rail-ink);
	}
	.rail-spacer {
		flex: 1;
	}
	.rail-btn {
		width: 44px;
		height: 44px;
		border-radius: var(--radius-card);
		color: var(--rail-ink);
		opacity: 0.72;
		font-size: 17px;
		line-height: 1;
	}
	.rail-btn:hover {
		background: var(--rail-hover);
		opacity: 1;
	}
	.rail-btn.accent {
		background: var(--accent);
		color: var(--accent-ink);
		opacity: 1;
		border-radius: 50%;
	}
	.rail-btn.accent:hover {
		background: var(--accent);
	}
	.top {
		display: flex;
		gap: 4px;
		padding: 12px 12px 6px;
	}
	/* The primary action of the column, so it is filled rather than outlined —
	   the same call as the round send button in the composer. */
	.new {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 46px;
		padding: 10px 16px;
		border-radius: var(--radius-pill);
		background: var(--accent);
		color: var(--accent-ink);
		box-shadow: var(--shadow-card);
		font-size: 14px;
		font-weight: 600;
	}
	.new:hover {
		background: var(--accent);
		box-shadow: var(--shadow-float);
	}
	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		flex: 0 0 auto;
		color: var(--text-faint);
		border-radius: 50%;
	}
	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.close {
		display: none;
	}
	.search {
		margin: 6px 12px 8px;
		padding: 11px 16px;
		background: var(--bg-sunken);
		border: none;
		border-radius: var(--radius-pill);
		font-size: 13px;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		padding: 0 10px 10px;
	}
	.group {
		padding: 14px 6px 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	/* A row is a card: it rises off the column when it is hovered or open,
	   rather than picking up a stripe. The stripe was a line, and this design
	   has no lines. */
	.row {
		position: relative;
		display: flex;
		align-items: center;
		margin-bottom: 3px;
		border-radius: var(--radius-card);
	}
	.row:hover {
		background: var(--bg-sunken);
	}
	.row.active {
		background: var(--accent-soft);
		box-shadow: var(--shadow-card);
	}
	.entry {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 4px 9px 9px;
		text-align: left;
	}
	.ava {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: var(--bg-hover);
		color: var(--text-muted);
		font-size: 13px;
		font-weight: 700;
		line-height: 1;
	}
	.ava.agented {
		background: color-mix(in oklab, var(--bg-raised) 72%, var(--agent) 28%);
		font-size: 15px;
		font-weight: 400;
	}
	.row.active .ava {
		background: var(--accent);
		color: var(--accent-ink);
	}
	.row.active .ava.agented {
		background: color-mix(in oklab, var(--bg-raised) 60%, var(--agent) 40%);
	}
	.txt {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 600;
	}
	.sub {
		display: flex;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--text-faint);
	}
	.branch {
		color: var(--accent);
		margin-right: 3px;
	}
	.when {
		flex: 0 0 auto;
	}
	/* Accented rather than faint: an unsent message is the one thing in a row
	   that is waiting on the user. */
	.draft {
		flex: 0 0 auto;
		color: var(--accent);
	}
	.more {
		align-self: stretch;
		padding: 6px 9px;
		color: var(--text-faint);
	}
	/* The one glyph left in the chrome: three dots are a shape, not a picture,
	   and every icon set draws them as exactly this. */
	.dots {
		font-size: 15px;
		line-height: 1;
	}
	/* Renaming, pinning, branching, archiving and deleting all live behind this
	   ⋯ — and it used to be revealed by hover, which a finger does not have and
	   a Tab key does not either. It hides only where a pointer can bring it
	   back, and even there a focused row shows it. */
	@media (hover: hover) and (min-width: 821px) {
		.more {
			opacity: 0;
		}
		.row:hover .more,
		.row:focus-within .more,
		.row.active .more {
			opacity: 1;
		}
	}
	/* A bin row states its two answers instead of hiding them behind a ⋯: one
	   of them is irreversible, and that is not a thing to discover by
	   exploring a menu. */
	.entry.static {
		cursor: default;
	}
	/* 268px of column cannot hold a title, a deadline and two verbs on one
	   line — measured: the title fell to "corb…" and the countdown was cut
	   mid-word. The answers go under the row they belong to instead. */
	.row.bin {
		flex-wrap: wrap;
		margin-bottom: 6px;
		background: var(--bg-sunken);
	}
	.bin-acts {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		width: 100%;
		padding: 0 8px 6px 53px;
	}
	.bin-act {
		flex: 0 0 auto;
		min-height: 36px;
		padding: 6px 11px;
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.bin-act:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.bin-act.danger:hover {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.rename {
		flex: 1;
		margin: 5px;
		padding: 8px 12px;
		background: var(--bg-sunken);
		border: 1px solid var(--accent);
		border-radius: var(--radius-card);
		font-size: 13.5px;
	}
	.menu {
		position: absolute;
		right: 6px;
		top: 100%;
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 158px;
		padding: 7px;
		background: var(--bg-raised);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-float);
	}
	.menu button {
		padding: 9px 12px;
		text-align: left;
		border-radius: 10px;
		font-size: 13px;
	}
	.menu button:hover {
		background: var(--bg-hover);
	}
	.menu .danger {
		color: var(--danger);
	}
	.empty {
		padding: 20px 12px;
		color: var(--text-faint);
		font-size: 13px;
		text-align: center;
		line-height: 1.5;
	}
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 4px;
		margin: 0 10px 10px;
		padding: 8px 6px;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
		font-size: 11.5px;
	}
	.settings-btn,
	.status {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 40px;
		padding: 6px 12px;
		border-radius: var(--radius-pill);
		color: var(--text-muted);
		font-size: 12.5px;
		white-space: nowrap;
	}
	.status {
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.settings-btn:hover,
	.status:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
	}
	/* On the dark rail, "unknown" has to be read against the rail, not the
	   page — `--text-faint` disappears there. */
	.rail .dot {
		width: 9px;
		height: 9px;
		background: var(--rail-ink);
	}
	.dot.ok {
		background: var(--ok);
	}
	.dot.ko {
		background: var(--danger);
	}

	@media (max-width: 820px) {
		.sidebar {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 50;
			width: min(84vw, 300px);
			flex-basis: auto;
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
			/* A drawer sliding in from the left edge: only the right corners
			   are visible, so only they are rounded. */
			border-radius: 0 var(--radius-panel) var(--radius-panel) 0;
			transform: translateX(-100%);
			transition: transform 0.22s ease;
			box-shadow: var(--shadow);
		}
		.sidebar.open {
			transform: none;
		}
		/* Collapsing is a desktop affordance; on mobile the drawer already
		   gets out of the way. */
		.sidebar.collapsed {
			width: min(84vw, 300px);
			flex-basis: auto;
			background: var(--bg-raised);
			border-radius: 0 var(--radius-panel) var(--radius-panel) 0;
		}
		.close {
			display: block;
			min-width: 44px;
			min-height: 44px;
		}
		.collapse {
			display: none;
		}
		/* Thumb-sized targets, like every other control on a phone. The list
		   flexes, so a taller footer costs rows of conversation, not layout. */
		.entry {
			min-height: 44px;
			padding-top: 10px;
			padding-bottom: 10px;
		}
		.more {
			min-width: 44px;
			min-height: 44px;
		}
		/* Five actions stacked 35px apart, "Supprimer" right under
		   "Archiver": exactly where a mis-tap is expensive. */
		.menu button {
			min-height: 44px;
		}
		.search {
			min-height: 44px;
		}
		.settings-btn,
		.status {
			min-height: 44px;
		}
	}
</style>
