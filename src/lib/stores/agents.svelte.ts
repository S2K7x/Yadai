import { api, withRetry } from '$lib/client/api';
import { humanizeError } from '$lib/errors';
import { panelState, type PanelState } from '$lib/availability';
import { normalizeAgents, type Agent, type AgentDraft } from '$lib/agents';
import { toasts } from './toast.svelte';

interface AgentsPayload {
	agents: unknown;
	agent?: unknown;
}

/**
 * The team roster, mirrored from `/api/agents`.
 *
 * Writes are NOT optimistic here, unlike the prompt library: a save is a form
 * submission the user is watching, the server is the one that validates, and
 * showing a rejected agent as saved would be a lie the next reload undoes.
 *
 * A *failed read* used to be swallowed whole — an empty `catch` and nothing
 * else. `items` stayed `[]`, which is also what a brand-new install looks like,
 * so the panel printed "No agents yet." over a roster it had never received and
 * the header chip announced "Agent: none" about a conversation that had one.
 * Measured by driving this store against the three ways the route actually
 * fails on this Pi — a dropped connection, the 12-burst rate gate, a 500 from a
 * SQLite read: three attempts each (`withRetry`), then silence. Hence
 * `loadError` and `state`, same three-answer shape as every other gated panel
 * (`$lib/availability`).
 */
class AgentStore {
	items = $state<Agent[]>([]);
	loaded = $state(false);
	saving = $state(false);
	loading = $state(false);
	/** Why the last read failed, or null once one succeeds. */
	loadError = $state<string | null>(null);

	#loading: Promise<void> | null = null;

	/** What the roster is worth right now: unread, ready, or unreadable. */
	get state(): PanelState {
		return panelState({ ready: this.loaded, disabled: false, error: this.loadError });
	}

	/** Load once; concurrent callers share the same request. */
	ensureLoaded(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		this.#loading ??= this.#load().finally(() => (this.#loading = null));
		return this.#loading;
	}

	/** Force a fresh read, for the panel's "Retry". */
	reload(): Promise<void> {
		this.loaded = false;
		return this.ensureLoaded();
	}

	async #load() {
		this.loading = true;
		try {
			const res = await withRetry(() => api<AgentsPayload>('/api/agents'));
			this.items = normalizeAgents(res.agents);
			this.loaded = true;
			this.loadError = null;
		} catch (err) {
			// No toast: this read runs at boot, where a toast would fire before
			// anyone is looking, and on opening the panel, which says so itself
			// — with the reason and a retry, which a fading toast cannot.
			this.loadError = humanizeError(err);
		} finally {
			this.loading = false;
		}
	}

	byId(id: string | null | undefined): Agent | undefined {
		if (!id) return undefined;
		return this.items.find((a) => a.id === id);
	}

	async #write(path: string, method: 'POST' | 'PATCH' | 'DELETE', draft?: AgentDraft) {
		this.saving = true;
		try {
			const res = await api<AgentsPayload>(path, {
				method,
				body: draft ? JSON.stringify(draft) : undefined
			});
			// Every write answers with the whole roster, so an accepted one also
			// repairs a read that had failed.
			this.items = normalizeAgents(res.agents);
			this.loaded = true;
			this.loadError = null;
			return res;
		} catch (err) {
			toasts.error(err);
			return null;
		} finally {
			this.saving = false;
		}
	}

	/** @returns the created agent, or null if the server refused it. */
	async create(draft: AgentDraft): Promise<Agent | null> {
		const res = await this.#write('/api/agents', 'POST', draft);
		if (!res) return null;
		toasts.success(`Agent "${draft.name.trim()}" created.`);
		return normalizeAgents([res.agent])[0] ?? null;
	}

	async update(id: string, draft: AgentDraft): Promise<Agent | null> {
		const res = await this.#write(`/api/agents/${encodeURIComponent(id)}`, 'PATCH', draft);
		if (!res) return null;
		toasts.success('Agent saved.');
		return normalizeAgents([res.agent])[0] ?? null;
	}

	async remove(id: string): Promise<boolean> {
		const res = await this.#write(`/api/agents/${encodeURIComponent(id)}`, 'DELETE');
		if (!res) return false;
		toasts.success('Agent deleted.');
		return true;
	}
}

export const agents = new AgentStore();
