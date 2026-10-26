import { api, withRetry } from '$lib/client/api';
import { read, write } from '$lib/client/storage';
import { humanizeError } from '$lib/errors';
import {
	DEFAULT_THEME,
	cachedTheme,
	normalizeTheme,
	planThemeUpdate,
	themeColor,
	themeVariables,
	type ThemeBaseline,
	type ThemeMode,
	type ThemeSettings
} from '$lib/theme';
import { toasts } from './toast.svelte';

/**
 * The active theme.
 *
 * Two storages on purpose. `/api/theme` is the truth — that is what makes the
 * phone and the desktop agree — but a network round-trip happens long after
 * the first paint, so the computed custom properties are also cached in
 * localStorage under `CACHE_KEY` and replayed by the inline script in
 * `app.html` before anything renders. Without that cache every launch flashes
 * the default palette.
 *
 * The cache holds the *computed* variables, so the early script needs no logic
 * at all and there is no second copy of the derivation rules to keep in step
 * with `theme.ts`. The settings ride along for display only — they say what
 * this device painted last, not what the server holds.
 *
 * `PUT /api/theme` replaces the row outright, so this store must never compose
 * a change on top of a palette it has not read. Measured before the guard
 * existed, replaying this store against a stubbed browser with the server
 * holding Nocturne / clair / accent `#00b3a4` and the initial GET failing:
 * `init()` repainted the defaults and overwrote the cache with them, then one
 * click sent `{preset:"terracotta",mode:"dark",accent:null,accent2:null}` —
 * the chosen palette gone on both sides, without a single message. That is
 * what `baseline` and `planThemeUpdate()` exist to prevent.
 */

const CACHE_KEY = 'yadai-theme-cache';

const UNLOADED =
	"Your theme could not be loaded: changing it now would overwrite the saved palette.";

interface ThemePayload {
	theme: unknown;
}

interface Cached {
	mode: ThemeMode;
	vars: Record<string, string>;
	settings: ThemeSettings;
}

class ThemeStore {
	settings = $state<ThemeSettings>(cachedTheme(read(CACHE_KEY)) ?? { ...DEFAULT_THEME });
	loaded = $state(false);
	saving = $state(false);
	/** Why the last load failed, if it did — the panel offers to retry it. */
	loadError = $state('');

	#timer: ReturnType<typeof setTimeout> | null = null;
	#loading: Promise<void> | null = null;

	/**
	 * The settings a change may be built on, or null while unknown.
	 *
	 * The cached palette is enough to *show* the truth, never to write it: it
	 * is what this device painted last, which may be older than the row.
	 */
	get baseline(): ThemeBaseline {
		return this.loaded ? this.settings : null;
	}

	/** Paint what is already on screen, then reconcile with the server. */
	async init(): Promise<void> {
		// A no-op when the cache seeded `settings` — the inline script has
		// already written exactly these variables. It matters only for a first
		// visit, and for a cache written before `settings` rode along.
		this.#apply(this.settings);
		await this.ensureLoaded();
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

	async #load(): Promise<void> {
		try {
			const res = await withRetry(() => api<ThemePayload>('/api/theme'));
			this.settings = normalizeTheme(res.theme);
			this.#apply(this.settings);
			this.loaded = true;
			this.loadError = '';
		} catch (err) {
			// Recorded rather than swallowed: the palette on screen is still the
			// cached one, but every control that writes is now unsafe and the
			// panel has to be able to say so.
			this.loadError = humanizeError(err);
		}
	}

	/** Apply immediately, persist a moment later — dragging a colour input
	 *  fires continuously and must not fire one PUT per pixel. */
	update(patch: Partial<ThemeSettings>): void {
		void this.#change(patch);
	}

	reset(): void {
		this.update({ ...DEFAULT_THEME });
	}

	toggleMode(): void {
		this.update({ mode: this.settings.mode === 'dark' ? 'light' : 'dark' });
	}

	/**
	 * Try once more to read the theme, then plan the change against it.
	 *
	 * Retrying here is what makes a transient failure invisible in the common
	 * case: the click itself re-reads, succeeds, and composes on the real row.
	 * Only a theme that still cannot be read refuses — with a reason.
	 */
	async #change(patch: Partial<ThemeSettings>): Promise<void> {
		await this.ensureLoaded();
		const result = planThemeUpdate(this.baseline, patch);
		if (!result.ok) {
			toasts.push('error', UNLOADED, {
				action: { label: 'Retry', run: () => void this.reload() }
			});
			return;
		}
		this.settings = result.settings;
		this.#apply(this.settings);
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#persist(), 400);
	}

	#apply(settings: ThemeSettings): void {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		const vars = themeVariables(settings);
		root.dataset.theme = settings.mode;
		for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);

		// The status bar of an installed PWA follows this, so it has to move
		// with the page background or the notch area stays the old colour.
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute('content', themeColor(settings));

		const cached: Cached = { mode: settings.mode, vars, settings };
		write(CACHE_KEY, JSON.stringify(cached));
	}

	async #persist(): Promise<void> {
		this.#timer = null;
		this.saving = true;
		try {
			const res = await api<ThemePayload>('/api/theme', {
				method: 'PUT',
				body: JSON.stringify({ theme: this.settings })
			});
			// Adopt the server's version: it is the one that was validated.
			this.settings = normalizeTheme(res.theme);
			this.#apply(this.settings);
			this.loaded = true;
			this.loadError = '';
		} catch (err) {
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}
}

export const theme = new ThemeStore();
