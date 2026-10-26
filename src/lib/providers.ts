/**
 * LLM providers as Hermes' dashboard describes them — pure logic, shared by
 * the proxy and the browser.
 *
 * Two ways to authenticate a provider, and the split is the dashboard's own
 * (`hermes_cli/provider_catalog.py`, `tab_for_auth_type`):
 *
 * - **API keys** — an env var in `~/.hermes/.env`. `GET /api/env` reports them
 *   with `category === "provider"`; the secret ones carry `is_password`.
 * - **Accounts** — an OAuth login. `GET /api/providers/oauth` reports those,
 *   each with a `flow` telling us how far we can take the user.
 *
 * No `fs`, no `$lib/server`, no DOM, so `node --test` imports it directly.
 * Nothing here ever holds a key in clear: the dashboard only ever hands us
 * `redacted_value`, and that is all this module carries.
 */

import { includesFolded, searchNeedle } from './text.ts';

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** One row of `GET /api/env`. Only the fields this app reads are declared. */
export interface EnvVarRow {
	is_set: boolean;
	redacted_value: string | null;
	description?: string;
	url?: string | null;
	category?: string;
	is_password?: boolean;
	/** Catalog slug of the provider the var belongs to ('' when unknown). */
	provider?: string;
	provider_label?: string;
}

export type EnvVarMap = Record<string, EnvVarRow>;

/** A single credential env var, stripped of everything the UI does not need. */
export interface ProviderKeyVar {
	key: string;
	description: string;
	url: string | null;
	isSet: boolean;
	/** Masked value straight from the dashboard, e.g. `sk-o...60c6`. */
	redacted: string | null;
}

/** Every credential var belonging to one provider. */
export interface ProviderKeyGroup {
	/** Catalog slug — the same one `/api/model/options` uses for `providers[].slug`. */
	provider: string;
	label: string;
	keys: ProviderKeyVar[];
}

/** Fallback bucket for a credential the catalog does not attach to a provider. */
export const UNGROUPED_PROVIDER_LABEL = 'Other';

/**
 * Environment variable names this app is willing to write.
 *
 * The dashboard has the authoritative denylist (PATH, LD_PRELOAD, …) and
 * answers 400 with a readable reason; this is only a shape check so an obvious
 * mistake fails here, in French, instead of travelling upstream.
 */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isEnvKeyName(key: unknown): key is string {
	return typeof key === 'string' && ENV_KEY_RE.test(key);
}

/** Longest credential we will forward. Real keys are far below this. */
export const MAX_KEY_LENGTH = 8192;

/**
 * Fold `GET /api/env` into one group per provider, keeping only the secret
 * credentials of `category === "provider"`.
 *
 * Base-URL overrides (`XAI_BASE_URL` and friends) are deliberately left out:
 * they are provider rows too, but they are configuration, not credentials, and
 * a panel that mixes the two invites pasting a key into the wrong field.
 *
 * Groups with a credential already set come first — the handful that matter
 * stay at the top of a list of thirty-odd providers.
 */
export function groupProviderKeys(env: EnvVarMap): ProviderKeyGroup[] {
	const groups = new Map<string, ProviderKeyGroup>();

	for (const [key, row] of Object.entries(env ?? {})) {
		if (!row || row.category !== 'provider' || row.is_password !== true) continue;
		const provider = row.provider ?? '';
		let group = groups.get(provider);
		if (!group) {
			group = {
				provider,
				label: row.provider_label || provider || UNGROUPED_PROVIDER_LABEL,
				keys: []
			};
			groups.set(provider, group);
		}
		group.keys.push({
			key,
			description: row.description ?? '',
			url: row.url ?? null,
			isSet: !!row.is_set,
			redacted: row.is_set ? (row.redacted_value ?? null) : null
		});
	}

	const result = [...groups.values()];
	for (const group of result) group.keys.sort((a, b) => a.key.localeCompare(b.key));
	result.sort((a, b) => {
		const diff = Number(isGroupConfigured(b)) - Number(isGroupConfigured(a));
		return diff !== 0 ? diff : a.label.localeCompare(b.label, 'fr');
	});
	return result;
}

/** Does this provider have at least one credential on disk? */
export function isGroupConfigured(group: ProviderKeyGroup): boolean {
	return group.keys.some((k) => k.isSet);
}

/**
 * Filter groups for the search box: a match on the provider keeps the whole
 * group, a match on one variable keeps just that variable.
 */
export function filterProviderGroups(
	groups: ProviderKeyGroup[],
	query = ''
): ProviderKeyGroup[] {
	const needle = searchNeedle(query);
	if (!needle) return groups;

	const result: ProviderKeyGroup[] = [];
	for (const group of groups) {
		if (includesFolded(group.label, needle) || includesFolded(group.provider, needle)) {
			result.push(group);
			continue;
		}
		const keys = group.keys.filter(
			(k) => includesFolded(k.key, needle) || includesFolded(k.description, needle)
		);
		if (keys.length) result.push({ ...group, keys });
	}
	return result;
}

/** Outcome of `POST /api/providers/validate`. */
export interface ValidationResult {
	ok: boolean;
	reachable: boolean;
	message?: string;
}

/**
 * Should a validation result stop the save?
 *
 * Only a provider that answered *and* rejected the key does. Not every
 * provider is probeable (`reachable: false` also means "no probe exists for
 * this one"), and refusing to save because the Pi is offline would be worse
 * than saving a key that turns out to be wrong.
 */
export function validationBlocks(result: ValidationResult | null): boolean {
	return !!result && !result.ok && result.reachable;
}

/** One sentence about what the probe found, or '' when there is nothing to say. */
export function validationMessage(result: ValidationResult | null): string {
	if (!result) return '';
	if (result.ok && result.reachable) return 'Key accepted by the provider.';
	if (result.ok) return 'This provider cannot be checked: the key will be saved as is.';
	if (!result.reachable) return 'Could not reach the provider to check the key.';
	return result.message || 'The provider rejected this key.';
}

// ---------------------------------------------------------------------------
// Accounts (OAuth)
// ---------------------------------------------------------------------------

/**
 * How far the dashboard can take a login.
 *
 * `external` means a third-party CLI owns the credentials: `POST .../start`
 * answers 400 with the command to run. We show the command; we do not pretend
 * to drive the flow.
 */
export type OauthFlowKind = 'device_code' | 'pkce' | 'external';

/** One entry of `GET /api/providers/oauth`. */
export interface OauthProvider {
	id: string;
	name: string;
	flow: string;
	cli_command?: string;
	docs_url?: string | null;
	disconnect_hint?: string | null;
	disconnect_command?: string | null;
	disconnectable?: boolean;
	status?: {
		logged_in?: boolean;
		source_label?: string | null;
		token_preview?: string | null;
		expires_at?: number | string | null;
	};
}

export function flowKind(provider: OauthProvider): OauthFlowKind {
	if (provider.flow === 'pkce') return 'pkce';
	if (provider.flow === 'device_code') return 'device_code';
	return 'external';
}

export function isConnected(provider: OauthProvider): boolean {
	return provider.status?.logged_in === true;
}

/**
 * Normalise the several shapes an expiry arrives in to epoch milliseconds.
 *
 * Measured on this gateway: `claude-code` reports `1786333053644` (ms), while
 * the device-code sessions carry seconds. ISO strings appear in the dashboard's
 * own docstrings. Anything unparseable is simply "no expiry known".
 */
export function parseExpiry(value: number | string | null | undefined): number | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return null;
		// Seconds vs milliseconds: 1e12 ms is the year 2001, 1e12 s is the year
		// 33658 — no real timestamp is ambiguous across that line.
		return value >= 1e12 ? value : value * 1000;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Short line under a provider's name.
 *
 * Connected: where the credentials actually live, which is the one thing the
 * status pill cannot say. Not connected: how the login works, rather than
 * repeating the pill.
 */
export function accountSummary(provider: OauthProvider): string {
	if (isConnected(provider)) {
		const source = provider.status?.source_label?.trim();
		return source ? `Credentials: ${source}` : 'Credentials managed by Yadai';
	}
	switch (flowKind(provider)) {
		case 'device_code':
			return 'Sign in with a pairing code';
		case 'pkce':
			return 'Sign in through the web';
		default:
			return 'Managed by its own CLI';
	}
}

// ---------------------------------------------------------------------------
// OAuth flow state machine
// ---------------------------------------------------------------------------

/** Upstream statuses are `pending | approved | denied | expired | error`. */
export type OauthPhase = 'awaiting' | 'approved' | 'denied' | 'expired' | 'error';

export interface OauthFlowState {
	providerId: string;
	providerName: string;
	kind: OauthFlowKind;
	sessionId: string;
	phase: OauthPhase;
	/** Device-code flows: the code to type on the provider's page. */
	userCode: string;
	verificationUrl: string;
	/** PKCE flows: the page to open, which hands back a code to paste. */
	authUrl: string;
	/** Epoch ms past which polling stops rather than hammering forever. */
	expiresAt: number;
	pollIntervalMs: number;
	message: string;
}

/** What `POST /api/providers/oauth/{id}/start` answers. */
export interface OauthStartResponse {
	session_id?: string;
	flow?: string;
	user_code?: string;
	verification_url?: string;
	auth_url?: string;
	expires_in?: number;
	poll_interval?: number;
}

/** What `GET /api/providers/oauth/{id}/poll/{sid}` answers. */
export interface OauthPollResponse {
	status?: string;
	error_message?: string | null;
	expires_at?: number | string | null;
}

/** Default window when the dashboard does not say — its own session TTL. */
const DEFAULT_FLOW_SECONDS = 900;
const MIN_POLL_MS = 2000;
const MAX_POLL_MS = 30_000;

export function beginOauthFlow(
	provider: OauthProvider,
	res: OauthStartResponse,
	now: number
): OauthFlowState {
	const seconds = Number(res.expires_in);
	const interval = Number(res.poll_interval);
	return {
		providerId: provider.id,
		providerName: provider.name,
		kind: res.flow === 'pkce' ? 'pkce' : 'device_code',
		sessionId: res.session_id ?? '',
		phase: 'awaiting',
		userCode: res.user_code ?? '',
		verificationUrl: res.verification_url ?? '',
		authUrl: res.auth_url ?? '',
		expiresAt: now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_FLOW_SECONDS) * 1000,
		pollIntervalMs: Number.isFinite(interval)
			? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, interval * 1000))
			: 5000,
		message: ''
	};
}

/**
 * Only device-code flows are pollable: PKCE waits for the user to paste a code
 * back, and both stop at the deadline so a forgotten tab does not poll a Pi
 * every five seconds until the browser is closed.
 */
export function shouldPollOauth(state: OauthFlowState | null, now: number): boolean {
	if (!state || state.kind !== 'device_code') return false;
	if (state.phase !== 'awaiting' || !state.sessionId) return false;
	return now < state.expiresAt;
}

/** Fold a poll answer into the flow. Returns the same object when nothing moved. */
export function advanceOauthFlow(
	state: OauthFlowState,
	poll: OauthPollResponse,
	now: number
): OauthFlowState {
	if (state.phase !== 'awaiting') return state;

	// The worker may push a firmer deadline than the one `start` announced.
	const upstreamExpiry = parseExpiry(poll.expires_at);
	const expiresAt = upstreamExpiry ?? state.expiresAt;
	const detail = poll.error_message?.trim() || '';

	switch (poll.status) {
		case 'approved':
			return { ...state, phase: 'approved', expiresAt, message: 'Account connected.' };
		case 'denied':
			return {
				...state,
				phase: 'denied',
				expiresAt,
				message: detail || 'Authorisation refused by the provider.'
			};
		case 'expired':
			return { ...state, phase: 'expired', expiresAt, message: detail || 'The code has expired.' };
		case 'error':
			return { ...state, phase: 'error', expiresAt, message: detail || 'Sign-in failed.' };
	}

	if (now >= expiresAt) {
		return { ...state, phase: 'expired', expiresAt, message: 'The code has expired.' };
	}
	return expiresAt === state.expiresAt ? state : { ...state, expiresAt };
}

/** Force a flow to a terminal phase — a failed poll request, a cancellation. */
export function settleOauthFlow(
	state: OauthFlowState,
	phase: Exclude<OauthPhase, 'awaiting'>,
	message: string
): OauthFlowState {
	if (state.phase !== 'awaiting') return state;
	return { ...state, phase, message };
}

export function isFlowSettled(state: OauthFlowState | null): boolean {
	return !!state && state.phase !== 'awaiting';
}

/** Whole seconds left before the code dies, floored at zero. */
export function secondsLeft(state: OauthFlowState, now: number): number {
	return Math.max(0, Math.floor((state.expiresAt - now) / 1000));
}
