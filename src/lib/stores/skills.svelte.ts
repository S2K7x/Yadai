import { api } from '$lib/client/api';
import { humanizeError } from '$lib/errors';
import { panelState, type PanelState } from '$lib/availability';
import { toasts } from './toast.svelte';
import {
	SKILL_FILE,
	skillKey,
	skillLabel,
	type EditableFile,
	type SkillFileEntry,
	type SkillRef
} from '$lib/skills';

interface ListResponse {
	available: boolean;
	entries: SkillFileEntry[];
	categories: string[];
}

interface ContentResponse extends SkillFileEntry {
	content: string;
}

/**
 * State of the skills editor.
 *
 * Deliberately its own store rather than more surface on `chat`: nothing here
 * touches a conversation, and the whole thing stays dormant (one HEAD-ish GET
 * on first open) until the user asks for the panel.
 */
class SkillsStore {
	/** null until the first load: "unknown", not "unavailable". */
	available = $state<boolean | null>(null);
	/**
	 * Why the last listing failed, or null once one succeeds.
	 *
	 * Kept apart from `available` on purpose. A 429 from the rate gate, an
	 * `EACCES` on the tree or a dropped connection used to land on
	 * `available = false`, which is the screen that blames the bind mount and
	 * tells the user to edit docker-compose.yml — about a directory that was
	 * mounted the whole time, and with no way back short of reloading the page.
	 */
	loadError = $state<string | null>(null);
	entries = $state<SkillFileEntry[]>([]);
	categories = $state<string[]>([]);
	loading = $state(false);

	/** File currently open in the editor. */
	selected = $state<SkillRef | null>(null);
	content = $state('');
	/** Contents as last read or written, to detect unsaved edits. */
	saved = $state('');
	loadingFile = $state(false);
	saving = $state(false);
	/** Set after a successful write, to remind about the gateway restart. */
	savedOnce = $state(false);

	/** What the panel should show: unread, ready, off, or unreadable. */
	get state(): PanelState {
		return panelState({
			ready: this.available === true,
			disabled: this.available === false,
			error: this.loadError
		});
	}

	get dirty(): boolean {
		return this.selected !== null && this.content !== this.saved;
	}

	get selectedLabel(): string {
		return this.selected ? skillLabel(this.selected) : '';
	}

	/**
	 * Re-read the listing.
	 *
	 * `background` is for the top-up after a create: the file is written and
	 * open in the editor, so a failed listing must not replace it with an error
	 * screen. It gets a toast instead — the right weight for "the tree on the
	 * left may be one row stale".
	 */
	async refresh(background = false) {
		this.loading = true;
		try {
			const res = await api<ListResponse>('/api/skills/files', { timeoutMs: 15_000 });
			this.available = res.available;
			this.entries = res.entries ?? [];
			this.categories = res.categories ?? [];
			this.loadError = null;
		} catch (err) {
			// No toast otherwise: this read runs with the panel on screen, and
			// the panel now says so itself — with the reason and a retry, which
			// a toast that fades after four seconds could not.
			if (background) toasts.error(err);
			else this.loadError = humanizeError(err);
		} finally {
			this.loading = false;
		}
	}

	/** Load a file into the editor. Refuses to discard unsaved edits silently. */
	async open(ref: SkillRef) {
		if (this.selected && skillKey(this.selected) === skillKey(ref)) return;
		this.selected = ref;
		this.content = '';
		this.saved = '';
		this.loadingFile = true;
		try {
			const params = new URLSearchParams({ category: ref.category, file: ref.file });
			if (ref.skill) params.set('skill', ref.skill);
			const res = await api<ContentResponse>(`/api/skills/files/content?${params}`);
			// A second click while the first was in flight must not win.
			if (!this.selected || skillKey(this.selected) !== skillKey(ref)) return;
			this.content = res.content;
			this.saved = res.content;
		} catch (err) {
			if (this.selected && skillKey(this.selected) === skillKey(ref)) this.selected = null;
			toasts.error(err);
		} finally {
			this.loadingFile = false;
		}
	}

	close() {
		this.selected = null;
		this.content = '';
		this.saved = '';
	}

	async save() {
		const ref = this.selected;
		if (!ref || this.saving) return;
		const content = this.content;
		this.saving = true;
		try {
			const entry = await api<SkillFileEntry>('/api/skills/files/content', {
				method: 'PUT',
				body: JSON.stringify({ ...ref, content })
			});
			this.saved = content;
			this.savedOnce = true;
			this.#merge(entry);
			toasts.success(`${skillLabel(ref)} saved.`);
		} catch (err) {
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}

	/** Create a skill and open it. Returns true when it worked. */
	async create(category: string, name: string, description: string): Promise<boolean> {
		try {
			const entry = await api<SkillFileEntry>('/api/skills/files', {
				method: 'POST',
				body: JSON.stringify({ category, name, description })
			});
			this.#merge(entry);
			if (!this.categories.includes(category)) {
				this.categories = [...this.categories, category].sort((a, b) => a.localeCompare(b, 'en'));
			}
			this.selected = null; // force a fresh read of what was written
			await this.open({ category: entry.category, skill: entry.skill, file: SKILL_FILE });
			toasts.success(`Skill "${name}" created.`);
			// The listing may also have gained a DESCRIPTION.md for a new category.
			this.refresh(true);
			return true;
		} catch (err) {
			toasts.error(err);
			return false;
		}
	}

	/** Fold an updated row into the listing without a full reload. */
	#merge(entry: SkillFileEntry) {
		const key = skillKey(entry);
		const index = this.entries.findIndex((e) => skillKey(e) === key);
		if (index >= 0) this.entries[index] = entry;
		else this.entries = [...this.entries, entry];
	}
}

export const skillsStore = new SkillsStore();
export type { EditableFile, SkillFileEntry, SkillRef };
