import { api, withRetry } from '$lib/client/api';
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
 */
class AgentStore {
	items = $state<Agent[]>([]);
	loaded = $state(false);
	saving = $state(false);

	#loading: Promise<void> | null = null;

	/** Load once; concurrent callers share the same request. */
	ensureLoaded(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		this.#loading ??= this.#load().finally(() => (this.#loading = null));
		return this.#loading;
	}

	async #load() {
		try {
			const res = await withRetry(() => api<AgentsPayload>('/api/agents'));
			this.items = normalizeAgents(res.agents);
			this.loaded = true;
		} catch {
			// The rest of the app works without a roster: a conversation with no
			// agent just runs on Hermes' default prompt. Staying unloaded lets a
			// later open retry.
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
			this.items = normalizeAgents(res.agents);
			this.loaded = true;
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
