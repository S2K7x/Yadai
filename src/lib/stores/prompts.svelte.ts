import { api, withRetry } from '$lib/client/api';
import { humanizeError } from '$lib/errors';
import {
	MAX_PROMPTS,
	addPrompt,
	normalizePrompts,
	removePrompt,
	type PromptBaseline,
	type PromptWriteRefusal,
	type PromptWriteResult,
	type SavedPrompt
} from '$lib/prompts';
import { uid } from '$lib/transcript';
import { toasts } from './toast.svelte';

/** Why a save was refused, said in French. */
const REASONS: Record<PromptWriteRefusal, string> = {
	unloaded: "Library not loaded: cannot write without risking erasing the prompts already saved.",
	empty: 'Nothing to save: the message is empty.',
	duplicate: 'This prompt is already saved.',
	full: `Library full (${MAX_PROMPTS} prompts) — delete one first.`
};

interface PromptsPayload {
	prompts: unknown;
}

/**
 * The saved-prompt library, mirrored from `/api/prompts`.
 *
 * Writes are optimistic and roll back on failure: a prompt that silently fails
 * to save is worse than one that visibly refuses to.
 *
 * Every write is a replace-all — `PUT /api/prompts` rewrites the whole prefs
 * row — so the one thing this store must never do is compose a write on top of
 * a library it has not read. Measured before the guard existed: a failed
 * initial GET left `items` empty, and the next save replaced three stored
 * prompts with one, under a green "Prompt enregistré." That is what `baseline`
 * and the `await this.ensureLoaded()` in both writers exist to prevent.
 */
class PromptStore {
	items = $state<SavedPrompt[]>([]);
	loaded = $state(false);
	saving = $state(false);
	/** Why the last load failed, if it did — the panel offers to retry it. */
	loadError = $state('');

	#loading: Promise<void> | null = null;
	/** Bumped by every accepted write, so a slow GET cannot undo a fresh one. */
	#writes = 0;

	/**
	 * The list a write may be built on, or null while it is unknown.
	 *
	 * `items` is `[]` both before the first load and for a genuinely empty
	 * library; only `loaded` tells the two apart, and confusing them here is
	 * precisely what erases the row.
	 */
	get baseline(): PromptBaseline {
		return this.loaded ? this.items : null;
	}

	/** Load once; concurrent callers share the same request. */
	ensureLoaded(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		this.#loading ??= this.#load().finally(() => (this.#loading = null));
		return this.#loading;
	}

	/** Force a fresh read, for the panel's "Réessayer". */
	reload(): Promise<void> {
		this.loaded = false;
		return this.ensureLoaded();
	}

	async #load() {
		const generation = this.#writes;
		try {
			const res = await withRetry(() => api<PromptsPayload>('/api/prompts'));
			// A write that landed while this GET was in flight is newer than what
			// it returns; adopting the response would resurrect the old list on
			// screen and hand it to the next replace-all.
			if (generation !== this.#writes) return;
			this.items = normalizePrompts(res.prompts);
			this.loaded = true;
			this.loadError = '';
		} catch (err) {
			// Recorded rather than swallowed: the panel used to sit on
			// "Chargement…" forever with no way to know the load had failed.
			this.loadError = humanizeError(err);
		}
	}

	async #persist(next: SavedPrompt[]): Promise<boolean> {
		const previous = this.items;
		this.items = next;
		this.saving = true;
		try {
			const res = await api<PromptsPayload>('/api/prompts', {
				method: 'PUT',
				body: JSON.stringify({ prompts: next })
			});
			// Adopt the server's version: it is the one that was bounded.
			this.#writes++;
			this.items = normalizePrompts(res.prompts);
			this.loaded = true;
			this.loadError = '';
			return true;
		} catch (err) {
			this.items = previous;
			toasts.error(err);
			return false;
		} finally {
			this.saving = false;
		}
	}

	/**
	 * Try once more to read the library, then plan the write against it.
	 *
	 * Retrying here is what makes a transient failure invisible in the common
	 * case: the save itself re-reads, succeeds, and writes against the real
	 * list. Only a library that still cannot be read refuses — with a reason.
	 */
	async #write(plan: (baseline: PromptBaseline) => PromptWriteResult): Promise<boolean> {
		await this.ensureLoaded();
		const result = plan(this.baseline);
		if (!result.ok) {
			if (result.reason === 'unloaded') {
				toasts.push('error', REASONS.unloaded, {
					action: { label: 'Retry', run: () => void this.reload() }
				});
			} else {
				toasts.info(REASONS[result.reason]);
			}
			return false;
		}
		return this.#persist(result.list);
	}

	async add(text: string): Promise<boolean> {
		return this.#write((baseline) => addPrompt(baseline, text, uid('p'), Date.now() / 1000));
	}

	async remove(id: string): Promise<boolean> {
		return this.#write((baseline) => removePrompt(baseline, id));
	}
}

export const prompts = new PromptStore();
