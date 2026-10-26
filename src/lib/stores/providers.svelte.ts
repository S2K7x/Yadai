import { api } from '$lib/client/api';
import { toasts } from './toast.svelte';
import { chat } from './chat.svelte';
import { humanizeError } from '$lib/errors';
import { panelState, type PanelState } from '$lib/availability';
import {
	advanceOauthFlow,
	beginOauthFlow,
	flowKind,
	settleOauthFlow,
	shouldPollOauth,
	validationBlocks,
	validationMessage,
	type OauthFlowState,
	type OauthPollResponse,
	type OauthProvider,
	type OauthStartResponse,
	type ProviderKeyGroup,
	type ValidationResult
} from '$lib/providers';

interface ProvidersResponse {
	available: boolean;
	message: string;
	keys: ProviderKeyGroup[];
	accounts: OauthProvider[];
}

interface ModelAssignmentResponse {
	ok?: boolean;
	confirm_required?: boolean;
	confirm_message?: string;
}

/**
 * State of the providers panel.
 *
 * Its own store, like the skills editor: nothing here touches a conversation,
 * and it stays dormant until the panel is opened for the first time. The one
 * live thing it owns is the OAuth poll timer, which `stopFlow()` must always
 * clear — the panel closing, the flow settling, or the user cancelling.
 */
class ProvidersStore {
	/** null until the first load: "unknown", not "unavailable". */
	available = $state<boolean | null>(null);
	/** Why the panel is off, when it is. Comes from the server, already in French. */
	message = $state('');
	/**
	 * Why the last read failed, or null once one succeeds.
	 *
	 * Separate from `message`: one is the dashboard explaining that it has no
	 * token, the other is this app failing to ask. Folding the second into
	 * `available = false` printed the "copy HERMES_DASHBOARD_SESSION_TOKEN"
	 * remedy at a user whose only problem was a dropped connection.
	 */
	loadError = $state<string | null>(null);
	keys = $state<ProviderKeyGroup[]>([]);
	accounts = $state<OauthProvider[]>([]);
	loading = $state(false);

	/** Env var whose editor is open, and what has been typed into it. */
	editing = $state<string | null>(null);
	draft = $state('');
	saving = $state(false);
	validating = $state(false);
	/** Result of the last probe, for the var in `editing`. */
	validation = $state<ValidationResult | null>(null);

	/** At most one login at a time — two device codes at once helps nobody. */
	flow = $state<OauthFlowState | null>(null);
	starting = $state<string | null>(null);
	submitting = $state(false);
	code = $state('');
	/** Ticks while a flow is pending, so the countdown re-renders. */
	now = $state(Date.now());

	/** Pending global-model switch awaiting an expensive-model confirmation. */
	confirmModel = $state<{ provider: string; model: string; message: string } | null>(null);
	switchingModel = $state(false);

	#pollTimer: ReturnType<typeof setTimeout> | null = null;

	/** What the panel should show: unread, ready, off, or unreadable. */
	get state(): PanelState {
		return panelState({
			ready: this.available === true,
			disabled: this.available === false,
			error: this.loadError
		});
	}

	get validationHint(): string {
		return validationMessage(this.validation);
	}

	async refresh() {
		this.loading = true;
		try {
			const res = await api<ProvidersResponse>('/api/providers', { timeoutMs: 20_000 });
			this.available = res.available;
			this.message = res.message ?? '';
			this.keys = res.keys ?? [];
			this.accounts = res.accounts ?? [];
			this.loadError = null;
		} catch (err) {
			this.loadError = humanizeError(err);
		} finally {
			this.loading = false;
		}
	}

	// -- API keys -----------------------------------------------------------

	edit(key: string) {
		this.editing = key;
		this.draft = '';
		this.validation = null;
	}

	cancelEdit() {
		this.editing = null;
		this.draft = '';
		this.validation = null;
	}

	/** Probe the typed value with the provider. Never blocks on its own. */
	async validate() {
		const key = this.editing;
		if (!key || !this.draft.trim() || this.validating) return;
		this.validating = true;
		try {
			this.validation = await api<ValidationResult>('/api/providers/keys/validate', {
				method: 'POST',
				body: JSON.stringify({ key, value: this.draft }),
				timeoutMs: 25_000
			});
		} catch (err) {
			this.validation = null;
			toasts.error(err);
		} finally {
			this.validating = false;
		}
	}

	/**
	 * Store the typed credential.
	 *
	 * Validates first when nothing has been probed yet, and stops only if the
	 * provider actively rejected the key — an unreachable or unprobeable
	 * provider must not prevent someone offline from saving.
	 */
	async saveKey() {
		const key = this.editing;
		if (!key || this.saving) return;
		const value = this.draft.trim();
		if (!value) return;

		if (!this.validation) await this.validate();
		if (validationBlocks(this.validation)) {
			toasts.push('error', validationMessage(this.validation));
			return;
		}

		this.saving = true;
		try {
			await api('/api/providers/keys', {
				method: 'PUT',
				body: JSON.stringify({ key, value }),
				timeoutMs: 25_000
			});
			toasts.success(`${key} saved.`);
			this.cancelEdit();
			await this.#reloadAll();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}

	async deleteKey(key: string) {
		if (this.saving) return;
		this.saving = true;
		try {
			await api('/api/providers/keys', {
				method: 'DELETE',
				body: JSON.stringify({ key }),
				timeoutMs: 25_000
			});
			toasts.success(`${key} deleted.`);
			if (this.editing === key) this.cancelEdit();
			await this.#reloadAll();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}

	// -- Accounts -----------------------------------------------------------

	/**
	 * Begin a login.
	 *
	 * `external` providers are not started at all: a third-party CLI owns their
	 * credentials, upstream answers 400 with the command, and the panel already
	 * displays that command. Asking anyway would only produce a scary error.
	 */
	async startOauth(provider: OauthProvider) {
		if (this.starting || this.flow) return;
		if (flowKind(provider) === 'external') return;

		this.starting = provider.id;
		try {
			const res = await api<OauthStartResponse>(
				`/api/providers/oauth/${encodeURIComponent(provider.id)}`,
				{ method: 'POST', body: '{}', timeoutMs: 30_000 }
			);
			this.code = '';
			this.now = Date.now();
			this.flow = beginOauthFlow(provider, res, this.now);
			this.#schedulePoll();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.starting = null;
		}
	}

	/** PKCE only: hand the pasted code back to Hermes. */
	async submitCode() {
		const flow = this.flow;
		if (!flow || flow.kind !== 'pkce' || this.submitting) return;
		const code = this.code.trim();
		if (!code) return;

		this.submitting = true;
		try {
			const res = await api<{ ok?: boolean; message?: string }>(
				`/api/providers/oauth/${encodeURIComponent(flow.providerId)}/submit`,
				{
					method: 'POST',
					body: JSON.stringify({ session_id: flow.sessionId, code }),
					timeoutMs: 40_000
				}
			);
			if (res?.ok) {
				this.flow = settleOauthFlow(flow, 'approved', 'Account connected.');
				this.code = '';
				await this.#reloadAll();
			} else {
				this.flow = settleOauthFlow(flow, 'error', res?.message || 'Sign-in failed.');
			}
		} catch (err) {
			this.flow = settleOauthFlow(flow, 'error', humanizeError(err));
		} finally {
			this.submitting = false;
		}
	}

	/** Drop a pending flow, telling Hermes so its background poller stops too. */
	async cancelFlow() {
		const flow = this.flow;
		this.stopFlow();
		if (!flow || flow.phase !== 'awaiting' || !flow.sessionId) return;
		try {
			await api(`/api/providers/oauth/sessions/${encodeURIComponent(flow.sessionId)}`, {
				method: 'DELETE'
			});
		} catch {
			/* the session expires on its own; nothing useful to say here */
		}
	}

	/** Clear the flow and its timer. Safe to call at any time. */
	stopFlow() {
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#pollTimer = null;
		this.flow = null;
		this.code = '';
	}

	async disconnect(provider: OauthProvider) {
		if (this.saving) return;
		this.saving = true;
		try {
			await api(`/api/providers/oauth/${encodeURIComponent(provider.id)}`, {
				method: 'DELETE',
				timeoutMs: 25_000
			});
			toasts.success(`${provider.name} disconnected.`);
			await this.#reloadAll();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}

	#schedulePoll() {
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#pollTimer = null;

		const flow = this.flow;
		if (!flow) return;
		// PKCE has nothing to poll, but the countdown must still tick.
		const delay = flow.kind === 'device_code' ? flow.pollIntervalMs : 1000;
		this.#pollTimer = setTimeout(() => void this.#tick(), delay);
	}

	async #tick() {
		this.#pollTimer = null;
		const flow = this.flow;
		if (!flow) return;

		this.now = Date.now();
		if (!shouldPollOauth(flow, this.now)) {
			// Either a PKCE flow just ticking, or the deadline passed.
			const advanced = advanceOauthFlow(flow, {}, this.now);
			this.flow = advanced;
			if (advanced.phase === 'awaiting') this.#schedulePoll();
			return;
		}

		try {
			const poll = await api<OauthPollResponse>(
				`/api/providers/oauth/${encodeURIComponent(flow.providerId)}/poll/${encodeURIComponent(flow.sessionId)}`,
				{ timeoutMs: 15_000 }
			);
			// The panel may have been closed while the request was in flight.
			if (this.flow !== flow) return;
			const advanced = advanceOauthFlow(flow, poll, Date.now());
			this.flow = advanced;
			if (advanced.phase === 'approved') await this.#reloadAll();
			if (advanced.phase === 'awaiting') this.#schedulePoll();
		} catch (err) {
			if (this.flow !== flow) return;
			// A 404 means the session is gone upstream — nothing left to wait for.
			this.flow = settleOauthFlow(flow, 'error', humanizeError(err));
		}
	}

	// -- Global default model ------------------------------------------------

	/**
	 * Repoint `config.yaml` at another provider/model.
	 *
	 * Only affects NEW conversations. An expensive model comes back as
	 * `confirm_required` with nothing written; the panel then shows the warning
	 * and `setDefaultModel(..., true)` replays it.
	 */
	async setDefaultModel(provider: string, model: string, confirmed = false) {
		if (this.switchingModel) return;
		this.switchingModel = true;
		try {
			const res = await api<ModelAssignmentResponse>('/api/providers/model', {
				method: 'POST',
				body: JSON.stringify({
					provider,
					model,
					confirm_expensive_model: confirmed
				}),
				timeoutMs: 30_000
			});
			if (res?.confirm_required) {
				this.confirmModel = {
					provider,
					model,
					message: res.confirm_message || 'This model is flagged as expensive.'
				};
				return;
			}
			this.confirmModel = null;
			toasts.success(`Default model: ${model}. It will apply to new chats.`);
			await chat.refreshCatalog();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.switchingModel = false;
		}
	}

	dismissConfirm() {
		this.confirmModel = null;
	}

	/**
	 * Reload the panel and Hermes' model catalog together: adding a credential
	 * or connecting an account is exactly what makes a provider appear in the
	 * model picker, and a stale picker right after is confusing.
	 */
	async #reloadAll() {
		await this.refresh();
		await chat.refreshCatalog();
	}
}

export const providersStore = new ProvidersStore();
