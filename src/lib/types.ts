/** Shapes returned by the Hermes API server (gateway/platforms/api_server.py). */

import type { SystemStats } from './system.ts';

export interface HermesSession {
	id: string;
	source?: string;
	user_id?: string | null;
	model?: string | null;
	title?: string | null;
	started_at?: number;
	ended_at?: number | null;
	end_reason?: string | null;
	message_count?: number;
	tool_call_count?: number;
	input_tokens?: number;
	output_tokens?: number;
	estimated_cost_usd?: number | null;
	actual_cost_usd?: number | null;
	parent_session_id?: string | null;
	last_active?: number | null;
	preview?: string | null;
	pinned?: boolean;
	archived?: boolean;
	has_system_prompt?: boolean;
	has_model_config?: boolean;
	/**
	 * Set only on a row whose id was rotated by a context compression.
	 *
	 * `list_sessions_rich(project_compression_tips=True)` projects a compressed
	 * conversation forward onto its live continuation, so `id` above is the
	 * continuation's and this is the id the conversation started life with.
	 * Absent on every other row.
	 */
	_lineage_root_id?: string | null;
	/**
	 * The custom agent this conversation belongs to.
	 *
	 * NOT a Hermes field: the binding lives in this app's SQLite and the
	 * `/api/sessions*` proxy adds it to every row on the way out.
	 */
	agent_id?: string;
	/**
	 * The reasoning effort this conversation's turns ask for.
	 *
	 * Not a Hermes field either, for the opposite reason to `agent_id`: upstream
	 * keeps `model_options` request-scoped and never stores them, so the choice
	 * lives in our `session_meta` and the stream route re-sends it with every
	 * message (see `src/lib/reasoning.ts`). Absent means `auto`.
	 */
	reasoning?: string;
	/**
	 * When this conversation was thrown away, on the bin listing only.
	 *
	 * Also not a Hermes field. Upstream the session is untouched — the delete
	 * has not happened yet and will not for `TRASH_DAYS` — so this exists
	 * nowhere but our own `session_meta`.
	 */
	deleted_at?: number;
}

/**
 * One entry of an assistant row's `tool_calls`.
 *
 * The canonical shape is OpenAI's — `{id, type, function: {name, arguments}}` —
 * which is what `agent/conversation_loop.py` canonicalises before sending and
 * what `hermes_state.py` round-trips through the column's JSON. The flat
 * `name` / `arguments` pair is the other shape some providers emit, and
 * `groupTranscript` accepts both; declaring both is what lets it stop casting
 * the list to `any[]` to read them.
 *
 * Every field is optional and nothing is validated on arrival — same
 * convention as `StreamEventData` below. `arguments` stays `unknown` because
 * upstream canonicalises it to a JSON *string* on the send path but persists
 * whatever the provider gave, which is sometimes an object.
 */
export interface HermesToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: unknown };
	/** Flat form. */
	name?: string;
	arguments?: unknown;
}

export interface HermesMessage {
	id?: number | string;
	session_id?: string;
	/**
	 * The three roles that make up a conversation, plus the bookkeeping rows
	 * the same table holds: `system`, and `session_meta`, which records the
	 * runtime of a stretch of conversation and carries a JSON object where a
	 * message carries text. The column is free text upstream, so this union
	 * names what Hermes is known to write rather than what it cannot —
	 * `groupTranscript()` filters by the three it folds, not by exclusion.
	 */
	role: 'user' | 'assistant' | 'tool' | 'system' | 'session_meta' | (string & {});
	/**
	 * A plain string on most rows, and the multimodal list on a row the user
	 * attached an image to — `_message_response` hands back the column as
	 * stored, and `ContentPart[]` is exactly what the chat endpoints accept on
	 * the way in. Declaring only `string` here is what forced every test of a
	 * multimodal row through an `as unknown as string`.
	 */
	content?: string | ContentPart[] | null;
	tool_call_id?: string | null;
	tool_calls?: HermesToolCall[] | null;
	tool_name?: string | null;
	timestamp?: number;
	token_count?: number;
	finish_reason?: string | null;
	reasoning?: string | null;
	reasoning_content?: string | null;
}

export interface HermesCapabilities {
	object: string;
	platform: string;
	model: string;
	auth: { type: string; required: boolean };
	runtime: Record<string, unknown>;
	features: Record<string, boolean | string>;
	endpoints: Record<string, { method: string; path: string }>;
}

/** `runtime` block returned by the session model-lock endpoint. */
export interface SessionRuntime {
	provider: string;
	model: string;
	route_source: string;
	requested?: { provider: string; model: string };
	/** "accepted" once Hermes has confirmed the lock. */
	model_lock?: string;
}

/**
 * Per-million-token prices, already formatted by Hermes.
 *
 * `_apply_pricing` (hermes_cli/inventory.py) hands the GUI strings, not
 * numbers — "$3.00", or the literal "free", or "" when the catalogue has no
 * figure. Only openrouter / nous / novita rows carry the key at all, which is
 * why every field here is optional.
 */
export interface ModelPrice {
	input?: string;
	output?: string;
	cache?: string | null;
	free?: boolean;
}

export interface ModelOptions {
	model: string;
	provider: string;
	providers: Array<{
		slug: string;
		name: string;
		is_current: boolean;
		authenticated: boolean;
		models: string[];
		total_models: number;
		warning?: string;
		/** Keyed by model id; absent for providers without a live catalogue. */
		pricing?: Record<string, ModelPrice>;
		/** Models the current account tier cannot select (Nous free tier). */
		unavailable_models?: string[];
		/**
		 * Keyed by model id: what `_apply_capabilities` knows about each one.
		 *
		 * `reasoning` comes from the models.dev catalogue and defaults to true
		 * upstream when a model is not listed there; `fast` mirrors
		 * `model_supports_fast_mode`. Always present, possibly empty.
		 */
		capabilities?: Record<string, { fast?: boolean; reasoning?: boolean }>;
	}>;
}

export interface ReadinessCheck {
	status: 'ok' | 'warn' | 'error' | string;
	[key: string]: unknown;
}

export interface HermesHealthDetailed {
	status: string;
	readiness: { status: string; checks: Record<string, ReadinessCheck> };
	platform: string;
	version: string;
	gateway_state: string | null;
	platforms: Record<string, { state?: string; error_code?: string | null }>;
	active_agents: number;
	gateway_busy: boolean;
	gateway_drainable: boolean;
	exit_reason: string | null;
	updated_at: string | null;
	pid: number;
}

/**
 * A cron job as `cron/jobs.py` stores it.
 *
 * Field names are the measured ones: `schedule` is an OBJECT
 * (`{kind, expr|minutes|run_at, display}`) and `schedule_display` is its human
 * form; `state` is the reconciled display state, not `paused`; the run stamps
 * are ISO strings named `*_run_at`, not `next_run` / `last_run`.
 */
export interface HermesJob {
	id?: string;
	name?: string;
	prompt?: string;
	schedule?: Record<string, unknown> | string;
	schedule_display?: string;
	state?: string;
	enabled?: boolean;
	deliver?: string;
	next_run_at?: string | null;
	last_run_at?: string | null;
	last_status?: string | null;
	last_error?: string | null;
	/**
	 * Added by this app from `job_meta`, not fields Hermes knows about: which
	 * agent the task belongs to, the instruction as typed (the stored prompt
	 * also carries the agent's card), and whether that card has since changed.
	 */
	agent_id?: string | null;
	instruction?: string;
	persona_stale?: boolean;
	[key: string]: unknown;
}

export interface StatusPayload {
	health: HermesHealthDetailed | null;
	healthError: string | null;
	jobs: HermesJob[];
	jobsAvailable: boolean;
	/** The host's vital signs, from the dashboard — null when it cannot answer. */
	system: SystemStats | null;
	systemError: string | null;
	turns: { active: number; limit: number };
}

export interface HermesSkill {
	name: string;
	description?: string;
	category?: string;
}

export interface HermesToolset {
	name: string;
	label?: string;
	description?: string;
	enabled?: boolean;
	configured?: boolean;
	tools?: string[];
}

/** SSE event names emitted by POST /api/sessions/{id}/chat/stream. */
export type StreamEventName =
	| 'run.started'
	| 'message.started'
	| 'assistant.delta'
	| 'tool.progress'
	| 'tool.started'
	| 'tool.completed'
	| 'tool.failed'
	| 'assistant.completed'
	| 'run.completed'
	| 'error'
	| 'done';

/**
 * The `data` object of one turn-stream frame.
 *
 * Every field is optional because one shape covers all eleven event names, and
 * none is validated on arrival — same convention as the other shapes in this
 * file. What the field names are is *not* a guess: they are the ones
 * `_event_payload` and its callers build in `api_server.py` (0.20.0), except
 * `status` and `code`, which only ever appear on an `error` frame this app
 * itself minted through `sseErrorResponse()`.
 *
 * This replaces a `Record<string, any>`, under which `data.tool_nmae` and
 * `data.delta.length` both type-checked.
 */
export interface StreamEventData {
	/** Filled in by default on EVERY frame, so it is the *requested* id — only
	 *  `assistant.completed` and `run.completed` carry the effective one. */
	session_id?: string;
	run_id?: string;
	seq?: number;
	/** Epoch seconds. */
	ts?: number;
	message_id?: string;
	/** `assistant.delta`, and `tool.progress` when `tool_name` is `_thinking`. */
	delta?: string;
	tool_name?: string;
	preview?: string | null;
	args?: unknown;
	/** `assistant.completed`: the authoritative final text. */
	content?: string;
	completed?: boolean;
	/** `run.completed`. Never read here — the transcript is reloaded instead. */
	messages?: unknown;
	usage?: unknown;
	runtime?: unknown;
	/** `error`. */
	message?: string;
	status?: number;
	code?: string;
}

/** A tool invocation as rendered in the agent timeline. */
export interface ToolStep {
	key: string;
	tool_name: string;
	status: 'running' | 'done' | 'failed';
	preview?: string | null;
	args?: unknown;
	result?: string | null;
	started_at: number;
	ended_at?: number;
}

/** Multimodal content part accepted by the Hermes session chat endpoints. */
export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface Attachment {
	id: string;
	name: string;
	mime: string;
	dataUrl: string;
	size: number;
}
