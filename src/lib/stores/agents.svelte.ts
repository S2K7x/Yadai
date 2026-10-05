import { api, withRetry } from '$lib/client/api';
import { normalizeAgents, type Agent, type AgentDraft } from '$lib/agents';
import { humanizeError } from '$lib/errors';
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
 * A failed read is *recorded*, not swallowed, and that is the difference
 * between the two states `items === []` used to carry at once. Nothing here is
 * destructive — every write goes to its own route and the server validates
 * against its own `listAgents()`, so an unread roster cannot erase one the way
 * an unread prompt library could (CLAUDE.md §15). What it could do was make
 * three surfaces state something false: the picker claimed the open
 * conversation had no agent, the panel claimed the team was empty, and the job
 * form silently budgeted an instruction as if no agent card rode along with
 * it. All three now ask `loadError` first, and offer to read again.
 */
class AgentStore {
	items = $state<Agent[]>([]);
	loaded = $state(false);
	saving = $state(false);
	/** True while a read is in flight, so "Réessayer" can say it is working. */
	loading = $state(false);
	/** Why the last read failed, if it did. '' once one has succeeded. */
	loadError = $state('');

	#loading: Promise<void> | null = null;

	/** Load once; concurrent callers share the same request. */
	ensureLoaded(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		this.#loading ??= this.#load().finally(() => (this.#loading = null));
		return this.#loading;
	}

	/** Force a fresh read, for the "Réessayer" the surfaces now offer. */
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
			this.loadError = '';
		} catch (err) {
			// No toast: this runs at boot beside the session list, which already
			// says the server is unreachable, and a second banner for the same
			// outage is noise. The surfaces that would otherwise lie read this.
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
			// A write answers with the whole roster, so it *is* a successful read:
			// a save is also how a transient failure repairs itself.
			this.items = normalizeAgents(res.agents);
			this.loaded = true;
			this.loadError = '';
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
		toasts.success(`Agent « ${draft.name.trim()} » créé.`);
		return normalizeAgents([res.agent])[0] ?? null;
	}

	async update(id: string, draft: AgentDraft): Promise<Agent | null> {
		const res = await this.#write(`/api/agents/${encodeURIComponent(id)}`, 'PATCH', draft);
		if (!res) return null;
		toasts.success('Agent enregistré.');
		return normalizeAgents([res.agent])[0] ?? null;
	}

	async remove(id: string): Promise<boolean> {
		const res = await this.#write(`/api/agents/${encodeURIComponent(id)}`, 'DELETE');
		if (!res) return false;
		toasts.success('Agent supprimé.');
		return true;
	}
}

export const agents = new AgentStore();
