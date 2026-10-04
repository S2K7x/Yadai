import { api, withRetry } from '$lib/client/api';
import { readJSON, writeJSON } from '$lib/client/storage';
import { ApiError, AppErrorCode } from '$lib/errors';
import { isModelAvailable, providerForModel, shortModelName } from '$lib/models';
import { isTerminalTurnEvent, readTurnStream } from '$lib/sse';
import { renameSession, rotatedSessionId } from '$lib/sessions';
import {
	DEFAULT_REASONING,
	modelDoesReasoning,
	normalizeReasoning,
	reasoningLabel,
	type ReasoningEffort
} from '$lib/reasoning';
import {
	TRANSCRIPT_PAGE,
	emptyAssistant,
	groupTranscript,
	mergeOlderRows,
	uid,
	type UiMessage
} from '$lib/transcript';
import { drafts } from './drafts.svelte';
import { toasts } from './toast.svelte';
import type {
	Attachment,
	ContentPart,
	HermesMessage,
	HermesSession,
	ModelOptions,
	SessionRuntime,
	StatusPayload,
	StreamEventData,
	ToolStep
} from '$lib/types';

/** What the last turn was, so "Renvoyer" can replay it verbatim. */
interface LastPrompt {
	text: string;
	attachments: Attachment[];
}

/**
 * One of the three choices a conversation carries, as `#choose()` applies it.
 *
 * Named rather than inlined on the method so the shape the three setters share
 * is a thing with a definition — and so a fourth choice has something to fill
 * in instead of a block to copy.
 */
interface SessionChoice<T> {
	/** The value the user picked, and the preference before this call. */
	value: T;
	was: T;
	/** Store the preference for new conversations, localStorage included. */
	remember: (value: T) => void;
	/** The conversation to re-pin on, or null for "next discussion only". */
	target: string | null;
	/** How the choice shows on a session row, and what to put back on failure. */
	row: (value: T) => Partial<HermesSession>;
	rollback: Partial<HermesSession>;
	/** `POST /api/sessions/{id}/<path>` with this body. */
	path: string;
	body: unknown;
	/** Ran once upstream accepted, with the session it accepted it for. */
	accepted?: (res: SessionChoiceResponse, id: string) => void;
}

/**
 * What the three per-conversation choice routes answer.
 *
 * All three echo the session they wrote to; only `POST .../model` carries a
 * `runtime` block, because only that one reaches Hermes — the agent binding and
 * the reasoning effort are ours and never leave this app's SQLite. Nothing is
 * validated on arrival, same convention as `$lib/types`: the point of naming
 * the shape is that `res.runtime?.model` no longer type-checks as anything.
 */
interface SessionChoiceResponse {
	session_id?: string;
	runtime?: SessionRuntime;
	agent_id?: string | null;
	reasoning?: string | null;
}

class ChatStore {
	sessions = $state<HermesSession[]>([]);
	/**
	 * Archived conversations, loaded on demand and kept apart from `sessions`.
	 *
	 * `GET /api/sessions` never returns an archived row, so filtering `sessions`
	 * on `archived` — which is what this used to do — could only ever yield an
	 * empty list once the sidebar had refreshed. The proxy rebuilds this one id
	 * by id instead.
	 */
	archivedSessions = $state<HermesSession[]>([]);
	loadingArchived = $state(false);
	/** True when the archive probe hit its cap and may be missing older rows. */
	archivedTruncated = $state(false);
	/** Conversations waiting in the bin, newest first. */
	trashedSessions = $state<HermesSession[]>([]);
	loadingTrash = $state(false);
	trashTruncated = $state(false);
	sessionId = $state<string | null>(null);
	messages = $state<UiMessage[]>([]);
	streaming = $state(false);
	/** True after stop(): a turn is still running server-side, unwatched. */
	detached = $state(false);
	loadingHistory = $state(false);
	/**
	 * True when the loaded window does not reach the start of the conversation.
	 *
	 * Set from the page being full rather than from `message_count`: that
	 * counter is incremented per appended row and never decremented, it counts
	 * system rows, and on a compression chain it belongs to the continuation —
	 * so it cannot be subtracted from what the window holds.
	 */
	olderHistory = $state(false);
	loadingOlder = $state(false);
	loadingSessions = $state(false);

	/** null while unknown, then true/false. Drives the offline banner. */
	connected = $state<boolean | null>(null);
	version = $state('');
	status = $state<StatusPayload | null>(null);
	/** `capabilities.features` — features are gated off this, not off a version. */
	features = $state<Record<string, boolean | string>>({});

	models = $state<ModelOptions | null>(null);
	/** Model used for a NEW session, and the default the picker shows. */
	nextModel = $state('');
	/** Agent a NEW conversation starts with. '' means Hermes' default prompt. */
	nextAgent = $state('');
	/** Reasoning effort a NEW conversation starts on. `auto` = Hermes decides. */
	nextReasoning = $state<ReasoningEffort>(DEFAULT_REASONING);
	skills = $state<Array<{ name: string; description?: string }>>([]);
	toolCount = $state(0);
	mcpTools = $state<string[]>([]);

	/**
	 * The transcript rows of the loaded window, oldest first.
	 *
	 * Kept beside `messages` because paging backwards has to re-fold the whole
	 * window: a page boundary can fall inside a turn, so the older rows change
	 * which bubble the tool steps belong to. Not `$state` — nothing reads it
	 * reactively, and proxying a 500-row array for that would be a waste.
	 */
	#rows: HermesMessage[] = [];
	/**
	 * Bumped every time the loaded window is thrown away.
	 *
	 * Two transcript reads can be in flight at once — tapping one conversation
	 * then another, or a page of older messages arriving after the thread was
	 * replaced. Each read captures this number and drops its answer if it no
	 * longer matches, which is also what keeps `loadingHistory` owned by the
	 * read that is still wanted.
	 */
	#window = 0;
	/**
	 * How many leading turns of `messages` were folded from `#rows`.
	 *
	 * A turn sent since the window loaded lives only in `messages` — it was
	 * built from the stream, and the rows Hermes persisted for it are not in
	 * `#rows`. Re-folding the window on top of `messages` would therefore erase
	 * the exchange that just happened, so the live tail past this index is kept
	 * and re-appended instead.
	 */
	#folded = 0;
	#abort: AbortController | null = null;
	#lastPrompt: LastPrompt | null = null;
	/**
	 * Session id the running turn's terminal frames reported.
	 *
	 * Differs from the id the turn was sent to only when Hermes compressed the
	 * conversation mid-turn and continued it elsewhere (CLAUDE.md §23).
	 */
	#streamSessionId: string | null = null;
	#healthTimer: ReturnType<typeof setTimeout> | null = null;
	#healthBackoff = 0;
	/**
	 * The catalogue fetch, while it is in flight.
	 *
	 * Kept so the one thing that genuinely needs it — pinning a model on a
	 * brand-new conversation — can wait for it, without the whole boot doing so.
	 */
	#catalog: Promise<void> | null = null;

	get current(): HermesSession | undefined {
		const id = this.sessionId;
		if (!id) return undefined;
		return this.sessions.find((s) => s.id === id) ?? this.archivedSessions.find((s) => s.id === id);
	}

	get canResend(): boolean {
		return !this.streaming && this.#lastPrompt !== null;
	}

	/** Model the next message will run on: the open session's, else nextModel. */
	get activeModel(): string {
		return (this.sessionId && this.current?.model) || this.nextModel;
	}

	/** Does this gateway expose POST /api/sessions/{id}/model? */
	get canSwitchModel(): boolean {
		return this.features.session_model_lock === true;
	}

	/** Agent the next message will run as: the open conversation's, else nextAgent. */
	get activeAgentId(): string {
		if (this.sessionId) return this.current?.agent_id ?? '';
		return this.nextAgent;
	}

	/** Reasoning effort the next message asks for: the open one's, else nextReasoning. */
	get activeReasoning(): ReasoningEffort {
		if (this.sessionId) return normalizeReasoning(this.current?.reasoning);
		return this.nextReasoning;
	}

	/**
	 * Does the catalogue say the active model thinks?
	 *
	 * True while the catalogue is still loading, and for any model it does not
	 * describe — same default as upstream's own `_apply_capabilities`.
	 */
	get canPickReasoning(): boolean {
		return modelDoesReasoning(this.models, this.activeModel);
	}

	// -- bootstrap ----------------------------------------------------------

	/**
	 * Boot.
	 *
	 * The catalogue is started here but deliberately **not** awaited. Nothing on
	 * screen at boot needs it: the header shows the open conversation's own
	 * model, and the model picker, the `/` skills palette and the tool counter
	 * are all things you have to reach for. Meanwhile it is by far the slowest
	 * call of the fan-out, because `GET /api/model/options` rebuilds Hermes'
	 * provider inventory behind a one-hour disk cache and refetches the provider
	 * catalogues over the internet when it has expired.
	 *
	 * **Measured against the running app on this Pi**, warm: capabilities 5 ms,
	 * sessions 6–60 ms, transcript 6 ms — but models 134 ms, and 1.9 s on the
	 * first call after the cache expired. Awaited, that was the whole
	 * time-to-first-message: replayed against the running app, first call to
	 * rendered transcript, the median went 181 ms → 52 ms — and ~1.9 s → ~50 ms
	 * once an hour, for a list nobody had asked to see. Started and left
	 * running, opening the app costs the session list plus the transcript, and
	 * the picker fills in behind.
	 */
	async init() {
		this.nextModel = readJSON('yadai-next-model', '');
		this.nextAgent = readJSON('yadai-next-agent', '');
		this.nextReasoning = normalizeReasoning(readJSON('yadai-next-reasoning', ''));
		// Nothing awaits this until `catalogReady()` might, so it is kept
		// non-rejecting: a floating rejection would reach the global
		// `unhandledrejection` net in +layout.svelte.
		this.#catalog = this.refreshCatalog().catch(() => undefined);
		await Promise.allSettled([this.refreshHealth(), this.refreshSessions()]);
		this.#scheduleHealth();
	}

	/**
	 * Wait for the catalogue if it has not landed yet.
	 *
	 * Only worth doing before creating a conversation: Hermes pins the model id
	 * on the session row, and a stale one makes every single turn fail with a
	 * 400 from the provider (CLAUDE.md §1). `refreshCatalog()` is what vets
	 * `nextModel` against what the gateway can actually route, so that is the
	 * one place the wait is owed.
	 */
	async catalogReady(): Promise<void> {
		await this.#catalog;
	}

	dispose() {
		if (this.#healthTimer) clearTimeout(this.#healthTimer);
		this.#healthTimer = null;
	}

	/**
	 * Poll health so the UI notices the gateway coming back on its own.
	 *
	 * Fast while down (the user is probably restarting it and wants to see the
	 * banner clear), slow while up — this runs on a Pi and the check walks the
	 * gateway's runtime state.
	 */
	#scheduleHealth() {
		if (this.#healthTimer) clearTimeout(this.#healthTimer);
		const delay = this.connected === false ? Math.min(3000 * 2 ** this.#healthBackoff, 30_000) : 60_000;
		this.#healthTimer = setTimeout(async () => {
			await this.refreshHealth();
			this.#scheduleHealth();
		}, delay);
	}

	async refreshHealth() {
		const wasConnected = this.connected;
		try {
			const res = await api<{
				health: { version: string };
				capabilities?: { features?: Record<string, boolean | string> };
			}>('/api/capabilities', { timeoutMs: 8000 });
			this.connected = true;
			this.#healthBackoff = 0;
			this.version = res.health?.version ?? '';
			this.features = res.capabilities?.features ?? {};
			if (wasConnected === false) {
				toasts.success('Connexion à Hermes rétablie.');
				// State may have moved on while we were blind.
				this.refreshSessions();
				this.#catalog = this.refreshCatalog().catch(() => undefined);
			}
		} catch {
			this.connected = false;
			this.#healthBackoff = Math.min(this.#healthBackoff + 1, 4);
		}
	}

	async refreshStatus() {
		try {
			this.status = await api<StatusPayload>('/api/status', { timeoutMs: 15_000 });
		} catch (err) {
			toasts.error(err);
		}
	}

	/**
	 * The model inventory and the skills/toolsets list.
	 *
	 * Fetched side by side: they are two unrelated endpoints and neither reads
	 * the other's answer, so chaining them only added the slower one's latency
	 * to the faster one's. Each keeps its own catch — a gateway that cannot list
	 * its models must still be able to list its skills.
	 */
	async refreshCatalog() {
		await Promise.all([this.#refreshModels(), this.#refreshSkills()]);
	}

	async #refreshModels() {
		try {
			this.models = await withRetry(() => api<ModelOptions>('/api/models'));
			// A model saved from a previous session may no longer be offered.
			if (!isModelAvailable(this.models, this.nextModel)) this.nextModel = this.models.model;
		} catch {
			/* the picker stays empty; chat still works on the server default */
		}
	}

	async #refreshSkills() {
		try {
			const res = await api<{
				skills: Array<{ name: string; description?: string }>;
				toolsets: Array<{ tools?: string[]; enabled?: boolean }>;
			}>('/api/skills');
			this.skills = res.skills ?? [];
			const tools = (res.toolsets ?? []).filter((t) => t.enabled !== false).flatMap((t) => t.tools ?? []);
			this.toolCount = new Set(tools).size;
			this.mcpTools = [...new Set(tools.filter((t) => t.startsWith('mcp_')))];
		} catch {
			/* skills palette unavailable — not fatal */
		}
	}

	async refreshSessions() {
		this.loadingSessions = true;
		try {
			const res = await withRetry(() =>
				api<{ data: HermesSession[] }>('/api/sessions?limit=200')
			);
			this.sessions = res.data ?? [];
			// Hermes may have compressed the open conversation since the last
			// listing, which gives it a new id. Keep writing to the row the
			// sidebar now shows: the stale id still exists, but posting to it
			// would replay the whole pre-compression transcript. Never mid-turn
			// — the in-flight stream is bound to the id it was started with.
			if (!this.streaming) {
				const moved = rotatedSessionId(this.sessions, this.sessionId);
				if (moved) {
					// The unsent text is keyed on the id too, so it has to follow.
					drafts.rename(this.sessionId, moved);
					this.sessionId = moved;
				}
			}
		} catch (err) {
			toasts.error(err, { label: 'Réessayer', run: () => this.refreshSessions() });
		} finally {
			this.loadingSessions = false;
		}
	}

	/**
	 * Load the archived conversations.
	 *
	 * Deliberately on demand: the proxy has to probe sessions one by one to
	 * find them, so this is far more expensive than a normal listing and has
	 * no business running on every sidebar refresh.
	 */
	async refreshArchived() {
		this.loadingArchived = true;
		try {
			const res = await api<{ data: HermesSession[]; truncated?: boolean }>(
				'/api/sessions?archived=true',
				{ timeoutMs: 30_000 }
			);
			this.archivedSessions = res.data ?? [];
			this.archivedTruncated = res.truncated === true;
		} catch (err) {
			toasts.error(err, { label: 'Réessayer', run: () => this.refreshArchived() });
		} finally {
			this.loadingArchived = false;
		}
	}

	/** Read the bin. Like the archive, it costs one request per row. */
	async refreshTrash() {
		this.loadingTrash = true;
		try {
			const res = await api<{ data: HermesSession[]; truncated?: boolean }>(
				'/api/sessions?trashed=true'
			);
			this.trashedSessions = res.data ?? [];
			this.trashTruncated = res.truncated === true;
		} catch (err) {
			toasts.error(err, { label: 'Réessayer', run: () => this.refreshTrash() });
		} finally {
			this.loadingTrash = false;
		}
	}

	// -- the three choices a conversation carries ---------------------------

	/**
	 * Apply one of the three choices a conversation carries.
	 *
	 * `setModel()`, `setAgent()` and `setReasoning()` were three copies of the
	 * same algorithm, and the last two said so in a comment — "same shape as
	 * setModel()" — while repeating it line by line. The shape: remember the
	 * choice as the default for NEW conversations, patch the open session's row
	 * optimistically, POST it, and on refusal put *both* halves back.
	 *
	 * The second half is the one a copy forgets. A model Hermes cannot route is
	 * refused outright (409 `model_lock_unavailable`) instead of falling back to
	 * the global default, so a rejection means the choice is unusable here at
	 * all: leaving it in `localStorage` would pin it on the next discussion and
	 * fail every turn of it (CLAUDE.md §1). Rolling back the preference is
	 * therefore not symmetry for its own sake, and it now exists once.
	 *
	 * `target` is the conversation to re-pin on, or null to only remember the
	 * preference — which is what a gateway without `session_model_lock` leaves
	 * the model picker able to do.
	 */
	async #choose<T>(choice: SessionChoice<T>): Promise<void> {
		choice.remember(choice.value);

		const id = choice.target;
		if (!id) return;

		this.#patchLocal(id, choice.row(choice.value));
		try {
			const res = await api<SessionChoiceResponse>(
				`/api/sessions/${encodeURIComponent(id)}/${choice.path}`,
				{ method: 'POST', body: JSON.stringify(choice.body) }
			);
			choice.accepted?.(res, id);
		} catch (err) {
			this.#patchLocal(id, choice.rollback);
			choice.remember(choice.was);
			toasts.error(err);
		}
	}

	/**
	 * Pick a model.
	 *
	 * It becomes the default for new conversations, and — when one is open and
	 * the gateway advertises `session_model_lock` — is re-pinned on that
	 * conversation right away: Hermes persists a confirmed model lock on the
	 * session row and resolves every later turn through it, so the switch
	 * takes effect from the next message instead of the next discussion.
	 */
	async setModel(model: string) {
		if (!model || model === this.activeModel) return;
		return this.#choose<string>({
			value: model,
			was: this.nextModel,
			remember: (value) => {
				this.nextModel = value;
				writeJSON('yadai-next-model', value);
			},
			// Without the capability the model is pinned at creation only, and
			// there is no endpoint to re-pin it: the choice waits for the next
			// discussion, which is what the picker says in that case.
			target: this.canSwitchModel ? this.sessionId : null,
			row: (value) => ({ model: value }),
			rollback: { model: this.current?.model ?? null },
			path: 'model',
			body: { model, provider: providerForModel(this.models, model) },
			accepted: (res, id) => {
				// Hermes echoes what it actually routed to; trust it over our guess.
				const applied = res.runtime?.model || model;
				this.#patchLocal(id, { model: applied });
				toasts.success(
					`Cette conversation utilise ${shortModelName(applied)} à partir du prochain message.`
				);
			}
		});
	}

	/**
	 * Pick the agent a conversation runs as.
	 *
	 * The persona is re-composed server-side on every turn, so the switch takes
	 * effect from the next message — what is already in the transcript keeps its
	 * author.
	 */
	async setAgent(agentId: string) {
		if (agentId === this.activeAgentId) return;
		const previous = this.current?.agent_id ?? '';
		return this.#choose<string>({
			value: agentId,
			was: this.nextAgent,
			remember: (value) => {
				this.nextAgent = value;
				writeJSON('yadai-next-agent', value);
			},
			target: this.sessionId,
			row: (value) => ({ agent_id: value || undefined }),
			rollback: { agent_id: previous || undefined },
			path: 'agent',
			body: { agent_id: agentId || null }
		});
	}

	/**
	 * Pick how hard the next messages think.
	 *
	 * Nothing reaches Hermes here: the effort is stored server-side and re-sent
	 * as `model_options` with every turn (see `src/lib/reasoning.ts`), so it
	 * applies from the next message and the transcript keeps whatever produced
	 * it.
	 */
	async setReasoning(effort: ReasoningEffort) {
		if (effort === this.activeReasoning) return;
		return this.#choose<ReasoningEffort>({
			value: effort,
			was: this.nextReasoning,
			remember: (value) => {
				this.nextReasoning = value;
				writeJSON('yadai-next-reasoning', value);
			},
			target: this.sessionId,
			row: (value) => ({ reasoning: value }),
			rollback: { reasoning: normalizeReasoning(this.current?.reasoning) },
			path: 'reasoning',
			body: { reasoning: effort },
			accepted: () => {
				toasts.success(
					effort === DEFAULT_REASONING
						? 'Effort de réflexion : réglage de Hermes, à partir du prochain message.'
						: `Effort de réflexion : ${reasoningLabel(effort)}, à partir du prochain message.`
				);
			}
		});
	}

	// -- session lifecycle --------------------------------------------------

	async newSession(title?: string): Promise<string | null> {
		try {
			const res = await api<{ session: HermesSession }>('/api/sessions', {
				method: 'POST',
				body: JSON.stringify({
					title,
					model: this.nextModel || undefined,
					agent_id: this.nextAgent || undefined,
					reasoning: this.nextReasoning
				})
			});
			this.sessions = [res.session, ...this.sessions];
			this.sessionId = res.session.id;
			this.#resetWindow();
			this.detached = false;
			return res.session.id;
		} catch (err) {
			toasts.error(err);
			return null;
		}
	}

	/** Forget the loaded transcript window, before loading another one. */
	#resetWindow(): number {
		this.#rows = [];
		this.messages = [];
		this.#folded = 0;
		this.olderHistory = false;
		this.loadingOlder = false;
		return ++this.#window;
	}

	/** Show the folded window, keeping whatever has been sent since. */
	#showWindow() {
		const live = this.messages.slice(this.#folded);
		const folded = groupTranscript(this.#rows);
		this.#folded = folded.length;
		this.messages = live.length ? [...folded, ...live] : folded;
	}

	/**
	 * Open a conversation on its MOST RECENT messages.
	 *
	 * `order` is not a cosmetic preference here. Upstream reads the page from
	 * whichever end it names — `latest` returns the last `limit` rows (in
	 * chronological order), `oldest` the first ones — and this call used to say
	 * `oldest`. Past the 500-row ceiling that meant opening a long conversation
	 * on its *beginning*, with everything that had just happened missing and no
	 * way to reach it. **Measured** against the running gateway on a 41-row
	 * conversation: `order=oldest&limit=5` returns rows 230…236, `order=latest`
	 * returns 273…277, and `order=latest&offset=5` the five before those — so
	 * the same endpoint also pages backwards, which is what `loadOlderHistory`
	 * uses.
	 */
	async openSession(id: string) {
		if (this.streaming) this.stop();
		this.sessionId = id;
		const gen = this.#resetWindow();
		this.detached = false;
		this.loadingHistory = true;
		try {
			const res = await withRetry(() =>
				api<{ data: HermesMessage[] }>(
					`/api/sessions/${encodeURIComponent(id)}/messages?order=latest&limit=${TRANSCRIPT_PAGE}`
				)
			);
			// A conversation opened meanwhile owns the thread now.
			if (this.#window !== gen) return;
			this.#rows = res.data ?? [];
			this.#showWindow();
			this.olderHistory = this.#rows.length >= TRANSCRIPT_PAGE;
		} catch (err) {
			if (err instanceof ApiError && err.code === AppErrorCode.SessionGone) {
				// Deleted from the CLI, Telegram, or another tab. Re-sync
				// rather than leaving a ghost row in the sidebar.
				this.sessions = this.sessions.filter((s) => s.id !== id);
				this.archivedSessions = this.archivedSessions.filter((s) => s.id !== id);
				this.sessionId = null;
				toasts.info("Cette conversation n'existe plus.");
			} else {
				toasts.error(err, { label: 'Réessayer', run: () => this.openSession(id) });
			}
		} finally {
			if (this.#window === gen) this.loadingHistory = false;
		}
	}

	/**
	 * Load the page of messages just before the window on screen.
	 *
	 * The offset is measured back from the newest row by upstream, so it is
	 * taken from what we hold; `mergeOlderRows` drops whatever a turn written
	 * meanwhile made overlap. A short page means the start of the conversation
	 * is now on screen.
	 */
	async loadOlderHistory() {
		const id = this.sessionId;
		if (!id || !this.olderHistory || this.loadingOlder || this.loadingHistory) return;
		const gen = this.#window;
		this.loadingOlder = true;
		try {
			const res = await withRetry(() =>
				api<{ data: HermesMessage[] }>(
					`/api/sessions/${encodeURIComponent(id)}/messages?order=latest&limit=${TRANSCRIPT_PAGE}&offset=${this.#rows.length}`
				)
			);
			if (this.#window !== gen) return;
			const older = res.data ?? [];
			this.#rows = mergeOlderRows(older, this.#rows);
			this.#showWindow();
			this.olderHistory = older.length >= TRANSCRIPT_PAGE;
		} catch (err) {
			toasts.error(err, { label: 'Réessayer', run: () => this.loadOlderHistory() });
		} finally {
			if (this.#window === gen) this.loadingOlder = false;
		}
	}

	/** Re-read the transcript from Hermes — used after detaching from a turn. */
	async reload() {
		if (!this.sessionId) return;
		this.detached = false;
		await Promise.all([this.openSession(this.sessionId), this.refreshSessions()]);
	}

	async renameSession(id: string, title: string) {
		const previous = this.sessions.find((s) => s.id === id)?.title;
		this.#patchLocal(id, { title });
		try {
			await api(`/api/sessions/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ title })
			});
		} catch (err) {
			this.#patchLocal(id, { title: previous ?? null });
			toasts.error(err);
		}
	}

	async togglePin(id: string) {
		const session = this.sessions.find((s) => s.id === id);
		if (!session) return;
		const pinned = !session.pinned;
		this.#patchLocal(id, { pinned });
		try {
			await api(`/api/sessions/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ pinned })
			});
		} catch (err) {
			this.#patchLocal(id, { pinned: !pinned });
			toasts.error(err);
		}
	}

	/**
	 * Archive or unarchive a conversation.
	 *
	 * The row moves between `sessions` and `archivedSessions` instead of just
	 * flipping a flag: archiving removes it from every upstream listing, so
	 * leaving it in `sessions` would make it reappear until the next refresh
	 * and then vanish without explanation.
	 */
	async toggleArchive(id: string) {
		const session =
			this.sessions.find((s) => s.id === id) ?? this.archivedSessions.find((s) => s.id === id);
		if (!session) return;
		const archived = !session.archived;
		this.#placeSession(session, archived);
		try {
			await api(`/api/sessions/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ archived })
			});
			toasts.success(archived ? 'Conversation archivée.' : 'Conversation désarchivée.');
		} catch (err) {
			this.#placeSession(session, !archived);
			toasts.error(err);
		}
	}

	/** Put a session in exactly one of the two lists, with `archived` set to match. */
	#placeSession(session: HermesSession, archived: boolean) {
		const row = { ...session, archived };
		this.sessions = this.sessions.filter((s) => s.id !== row.id);
		this.archivedSessions = this.archivedSessions.filter((s) => s.id !== row.id);
		if (archived) this.archivedSessions = [row, ...this.archivedSessions];
		else this.sessions = [row, ...this.sessions];
	}

	/**
	 * Move a conversation to the bin.
	 *
	 * Nothing is destroyed: the route writes a flag on our own row and leaves
	 * Hermes alone, so this is reversible for thirty days. Two nets, not one —
	 * "Annuler" right here for the slip of the finger, and the bin for the
	 * mistake noticed a week later.
	 *
	 * The draft is *kept* rather than cleared, unlike before: throwing the
	 * conversation away no longer throws its unsent message away with it.
	 */
	async deleteSession(id: string) {
		const snapshot = this.sessions;
		const archivedSnapshot = this.archivedSessions;
		const wasOpen = this.sessionId === id;
		this.sessions = this.sessions.filter((s) => s.id !== id);
		this.archivedSessions = this.archivedSessions.filter((s) => s.id !== id);
		if (wasOpen) {
			this.sessionId = null;
			this.#resetWindow();
		}
		try {
			await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
			toasts.push('success', 'Conversation dans la corbeille.', {
				action: { label: 'Annuler', run: () => void this.restoreSession(id) }
			});
		} catch (err) {
			// A 404 means it was already gone — the optimistic removal was right.
			if (err instanceof ApiError && err.code === AppErrorCode.SessionGone) return;
			this.sessions = snapshot;
			this.archivedSessions = archivedSnapshot;
			toasts.error(err);
		}
	}

	/** Take a conversation back out of the bin and put its row back. */
	async restoreSession(id: string) {
		try {
			const res = await api<{ session: HermesSession }>(
				`/api/sessions/${encodeURIComponent(id)}/restore`,
				{ method: 'POST', body: JSON.stringify({}) }
			);
			this.trashedSessions = this.trashedSessions.filter((s) => s.id !== id);
			const session = res.session;
			if (session?.archived) this.archivedSessions = [session, ...this.archivedSessions];
			else await this.refreshSessions();
			toasts.success('Conversation restaurée.');
		} catch (err) {
			toasts.error(err, { label: 'Réessayer', run: () => void this.restoreSession(id) });
		}
	}

	/**
	 * Empty one row of the bin for good.
	 *
	 * This is the only call in the app that reaches `DELETE` on the gateway
	 * with `purge=true`, and it is the only one that cannot be taken back —
	 * hence the confirmation, which the ordinary delete no longer needs.
	 */
	async purgeSession(id: string) {
		const snapshot = this.trashedSessions;
		this.trashedSessions = this.trashedSessions.filter((s) => s.id !== id);
		drafts.clear(id);
		try {
			await api(`/api/sessions/${encodeURIComponent(id)}?purge=true`, { method: 'DELETE' });
			toasts.success('Conversation supprimée définitivement.');
		} catch (err) {
			if (err instanceof ApiError && err.code === AppErrorCode.SessionGone) return;
			this.trashedSessions = snapshot;
			toasts.error(err);
		}
	}

	/** Branch the current conversation. Hermes closes the parent as
	 *  "branched", so both rows are refreshed from the server afterwards. */
	async forkSession(id: string) {
		try {
			const res = await api<{ session: HermesSession }>(
				`/api/sessions/${encodeURIComponent(id)}/fork`,
				{ method: 'POST', body: JSON.stringify({}) }
			);
			await this.refreshSessions();
			await this.openSession(res.session.id);
			toasts.success('Branche créée.');
		} catch (err) {
			toasts.error(err);
		}
	}

	/** Both lists: renaming or pinning works from the archived view too. */
	#patchLocal(id: string, patch: Partial<HermesSession>) {
		const apply = (list: HermesSession[]) =>
			list.map((s) => (s.id === id ? { ...s, ...patch } : s));
		this.sessions = apply(this.sessions);
		this.archivedSessions = apply(this.archivedSessions);
	}

	// -- the turn -----------------------------------------------------------

	/**
	 * Detach from the running turn.
	 *
	 * This does NOT interrupt the agent, and cannot: the Sessions API has no
	 * stop endpoint (`/v1/runs/{id}/stop` only knows runs submitted through
	 * `POST /v1/runs`), and dropping the SSE connection does not cancel the
	 * run either — measured: a turn aborted after 6 s still ran its tools and
	 * persisted its answer ~25 s later.
	 *
	 * So we stop rendering, flag the turn as detached, and tell the user the
	 * answer will land in the transcript. `reload()` fetches it.
	 */
	stop() {
		this.#abort?.abort();
		this.#abort = null;
		this.streaming = false;
		this.detached = true;
		const last = this.messages.at(-1);
		if (last?.streaming) {
			last.streaming = false;
			last.detached = 'stopped';
			for (const step of last.steps) if (step.status === 'running') step.status = 'done';
		}
	}

	/**
	 * The stream ended before the turn did.
	 *
	 * Measured: an SSE body that stops mid-turn without `done` — the upstream
	 * write loop bailing out of its `except Exception`, a proxy closing the
	 * response — leaves the reader done and throws nothing. Left alone, the
	 * half-written answer would render exactly like a finished one, which is
	 * worse than an error: the user cannot tell it is not what Hermes said.
	 *
	 * The agent keeps running server-side (same measurement as detaching), so
	 * the turn is flagged rather than failed, and the real answer is one reload
	 * away.
	 */
	#truncated(assistant: UiMessage) {
		this.detached = true;
		assistant.detached = 'truncated';
		for (const step of assistant.steps) if (step.status === 'running') step.status = 'done';
		toasts.push('error', "Le flux s'est interrompu avant la fin du tour.", {
			action: { label: 'Recharger', run: () => this.reload() }
		});
	}

	/** Re-send the previous prompt as a new turn. */
	async resend() {
		if (!this.#lastPrompt || this.streaming) return;
		const { text, attachments } = this.#lastPrompt;
		await this.send(text, attachments);
	}

	/**
	 * Run one turn.
	 *
	 * @returns `true` once the message is on screen and the turn has started —
	 * from then on the transcript owns it. `false` means nothing was sent and
	 * nothing was rendered, so the caller still owns the text: the composer
	 * clears itself *before* calling (creating the conversation moves
	 * `sessionId`, and with it the key the draft is filed under), so a `false`
	 * that nobody acts on is a typed message deleted without a trace.
	 *
	 * **Measured** against the built app with the gateway down — the ordinary
	 * state after `systemctl --user restart hermes-gateway`, or a phone off the
	 * tailnet: `POST /api/sessions` answers
	 * `502 {"code":"hermes_unreachable"}`, `newSession()` returns null, and this
	 * used to bail here having pushed nothing into `messages`.
	 */
	async send(text: string, attachments: Attachment[] = []): Promise<boolean> {
		if (this.streaming) return false;
		const trimmed = text.trim();
		if (!trimmed && attachments.length === 0) return false;

		this.detached = false;
		this.#lastPrompt = { text, attachments };

		let id = this.sessionId;
		if (!id) {
			// The catalogue is no longer awaited at boot, so this is where the
			// debt is settled: a new conversation pins a model id on its session
			// row for good, and one the gateway cannot route makes every turn
			// fail (CLAUDE.md §1). Already resolved in the common case — the
			// user had to type something first.
			await this.catalogReady();
			id = await this.newSession(titleFrom(trimmed));
			// `newSession()` has already said why in a toast. Saying "not sent"
			// is this return value's whole job.
			if (!id) return false;
		}

		// Hermes accepts a plain string or an OpenAI-style content array.
		// Only images are allowed: non-image data: URLs and file/file_id parts
		// are rejected with 400 unsupported_content_type.
		const payload: string | ContentPart[] = attachments.length
			? [
					...attachments.map<ContentPart>((a) => ({
						type: 'image_url',
						image_url: { url: a.dataUrl }
					})),
					{ type: 'text', text: trimmed }
				]
			: trimmed;

		this.messages.push({
			id: uid('u'),
			role: 'user',
			content: trimmed,
			images: attachments.map((a) => a.dataUrl),
			steps: [],
			reasoning: '',
			streaming: false,
			timestamp: Date.now() / 1000
		});
		this.messages.push(emptyAssistant());
		// Read the pushed element back: $state hands out a proxy, and only
		// mutations through that proxy are reactive.
		const assistant = this.messages[this.messages.length - 1];

		this.streaming = true;
		this.#streamSessionId = null;
		this.#abort = new AbortController();

		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: payload }),
				signal: this.#abort.signal
			});
			if (!res.body) throw new Error('Réponse sans corps.');
			if (!(await this.#consume(res.body, assistant))) this.#truncated(assistant);
		} catch (err) {
			if ((err as Error)?.name !== 'AbortError') {
				assistant.error = err instanceof Error ? err.message : String(err);
				// Losing the socket mid-turn does not stop the agent, so the
				// answer is probably still coming — offer to fetch it.
				toasts.push('error', 'La connexion au flux a été perdue.', {
					action: { label: 'Recharger', run: () => this.reload() }
				});
				this.connected = false;
				this.#scheduleHealth();
			}
		} finally {
			assistant.streaming = false;
			this.streaming = false;
			this.#abort = null;
			this.#adoptStreamRotation(id);
			// message_count / preview / last_active only change server-side.
			this.refreshSessions();
		}
		// Reached even on a mid-turn failure: the user message is in the
		// transcript by now and the agent keeps running server-side (§16), so
		// the text is no longer the composer's to hold back.
		return true;
	}

	/**
	 * Remember the session id a terminal frame reported.
	 *
	 * Only `assistant.completed` and `run.completed` carry the *effective* id
	 * upstream — every other frame gets the requested one filled in by default —
	 * so this is deliberately called from those two cases only.
	 */
	#noteSessionId(value: unknown) {
		if (typeof value === 'string' && value) this.#streamSessionId = value;
	}

	/**
	 * Follow a compression that rotated this conversation while the turn ran.
	 *
	 * `refreshSessions()` already moves the open conversation onto its
	 * continuation, but only once a listing has come back with
	 * `_lineage_root_id`. The turn's own last frames say it earlier and without
	 * a round-trip, which matters because between the two the next message would
	 * be posted to the old id — and Hermes would replay the whole
	 * pre-compression transcript it just spent a turn compressing.
	 *
	 * The sidebar row is carried over rather than dropped so the model and agent
	 * pickers do not blink through "unknown conversation" until the refresh
	 * lands. The server has already moved the agent binding onto the new id by
	 * the time the stream ends (`adoptRotation` in `server/turns.ts`).
	 */
	#adoptStreamRotation(startedWith: string) {
		const moved = this.#streamSessionId;
		this.#streamSessionId = null;
		if (!moved || moved === startedWith) return;
		this.sessions = renameSession(this.sessions, startedWith, moved);
		// The unsent text is keyed on the id too, so it has to follow.
		drafts.rename(startedWith, moved);
		// Not if the user has moved on: the open conversation is someone else's.
		if (this.sessionId === startedWith) this.sessionId = moved;
	}

	/** @returns true if the turn reached a conclusion, false if the stream just stopped. */
	async #consume(body: ReadableStream<Uint8Array>, assistant: UiMessage): Promise<boolean> {
		let terminated = false;
		for await (const { frames } of readTurnStream(body)) {
			for (const frame of frames) {
				this.#applyEvent(frame.event, frame.data, assistant);
				if (isTerminalTurnEvent(frame.event)) terminated = true;
				// Returning here releases the reader: `readTurnStream` cancels it
				// in its `finally`, which `for await` runs on an early exit too.
				if (frame.event === 'done') return true;
			}
		}
		return terminated;
	}

	#applyEvent(event: string, data: StreamEventData, assistant: UiMessage) {
		switch (event) {
			case 'assistant.delta':
				assistant.content += data.delta ?? '';
				break;

			case 'tool.progress':
				// Emitted for reasoning.available with tool_name "_thinking".
				if (data.tool_name === '_thinking') assistant.reasoning += data.delta ?? '';
				break;

			case 'tool.started':
				assistant.steps.push({
					key: `${data.tool_name}:${data.seq}`,
					tool_name: data.tool_name || 'tool',
					status: 'running',
					preview: data.preview,
					args: data.args,
					started_at: data.ts ?? Date.now() / 1000
				});
				break;

			case 'tool.completed':
			case 'tool.failed': {
				const status: ToolStep['status'] = event === 'tool.failed' ? 'failed' : 'done';
				// Match the most recent running step with the same tool name;
				// tool.started/completed carry different seq values.
				const step = [...assistant.steps]
					.reverse()
					.find((s) => s.tool_name === data.tool_name && s.status === 'running');
				if (step) {
					step.status = status;
					step.result = data.preview ?? step.result;
					step.ended_at = data.ts ?? Date.now() / 1000;
				} else {
					assistant.steps.push({
						key: `${data.tool_name}:${data.seq}`,
						tool_name: data.tool_name || 'tool',
						status,
						result: data.preview,
						started_at: data.ts ?? Date.now() / 1000,
						ended_at: data.ts ?? Date.now() / 1000
					});
				}
				break;
			}

			case 'assistant.completed':
				// Authoritative final text: deltas can miss content the agent
				// produced through non-streaming paths (e.g. tool-rendered media
				// resolved to data: URLs).
				if (typeof data.content === 'string' && data.content) assistant.content = data.content;
				this.#noteSessionId(data.session_id);
				break;

			case 'run.completed':
				assistant.streaming = false;
				this.#noteSessionId(data.session_id);
				break;

			case 'error': {
				const err = new ApiError(data.status || 500, data.message || 'Erreur inconnue', data.code);
				assistant.error = err.message;
				// A refused turn (429, bad payload) never started, so replaying
				// it is safe and is what the user wants.
				const canReplay = err.status === 429 || err.status >= 500;
				toasts.error(err, canReplay ? { label: 'Renvoyer', run: () => this.resend() } : undefined);
				break;
			}
		}
	}

	// -- export -------------------------------------------------------------

	/** Render the open conversation as a markdown document. */
	toMarkdown(): string {
		const session = this.current;
		const lines: string[] = [`# ${session?.title || 'Conversation Hermes'}`, ''];
		if (session?.model) lines.push(`_Modèle : ${session.model}_`, '');
		for (const msg of this.messages) {
			lines.push(msg.role === 'user' ? '## Vous' : '## Hermes', '');
			if (msg.steps.length) {
				lines.push(
					`<details><summary>${msg.steps.length} étape(s) d'agent</summary>`,
					'',
					...msg.steps.map((s) => `- \`${s.tool_name}\` — ${s.status}`),
					'',
					'</details>',
					''
				);
			}
			lines.push(msg.content || '_(vide)_', '');
		}
		return lines.join('\n');
	}
}

/** First line of the prompt, trimmed to something that fits a sidebar row. */
function titleFrom(text: string): string {
	const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
	const clean = firstLine.trim().replace(/\s+/g, ' ');
	if (!clean) return 'Nouvelle discussion';
	return clean.length > 58 ? `${clean.slice(0, 57)}…` : clean;
}

export const chat = new ChatStore();
