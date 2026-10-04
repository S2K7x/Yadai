import type { ContentPart, HermesMessage, HermesToolCall, ToolStep } from './types';
import type { IconName } from './icons';

/** A turn as the UI renders it: one bubble, plus the agent steps behind it. */
export interface UiMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	/** Images the user attached, as data: URLs (echoed back into the bubble). */
	images: string[];
	steps: ToolStep[];
	reasoning: string;
	streaming: boolean;
	/**
	 * The turn is still running server-side but nothing is rendering it any
	 * more: either the user detached (`stopped`) or the stream ended before the
	 * turn did (`truncated`). Both offer a reload; only the wording differs.
	 */
	detached?: 'stopped' | 'truncated';
	error?: string;
	timestamp: number;
}

let counter = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function emptyAssistant(): UiMessage {
	return {
		id: uid('a'),
		role: 'assistant',
		content: '',
		images: [],
		steps: [],
		reasoning: '',
		streaming: true,
		timestamp: Date.now() / 1000
	};
}

/**
 * Extract the text of a persisted message, whose content may be multimodal.
 *
 * The declared type says `string | ContentPart[] | null`, but nothing upstream
 * validates the column, so each part is still narrowed field by field rather
 * than trusted — a `Partial<ContentPart>` is what the guards actually assume.
 */
function textOf(content: HermesMessage['content']): { text: string; images: string[] } {
	if (typeof content === 'string') return { text: content, images: [] };
	if (Array.isArray(content)) {
		const parts: string[] = [];
		const images: string[] = [];
		for (const part of content as Array<Partial<ContentPart> | null | undefined>) {
			if (!part || typeof part !== 'object') continue;
			if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
			else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
				images.push(part.image_url.url);
			}
		}
		return { text: parts.join('\n'), images };
	}
	return { text: '', images: [] };
}

/**
 * Fold a persisted Hermes transcript into UI turns.
 *
 * The stored shape is user -> assistant(tool_calls) -> tool -> ... -> assistant.
 * Tool rows and intermediate assistant rows collapse into the trailing
 * assistant bubble's step list, so reloading a session looks like what the
 * live stream produced.
 */
export function groupTranscript(messages: HermesMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	let current: UiMessage | null = null;

	const flush = () => {
		if (current) out.push(current);
		current = null;
	};

	for (const msg of messages) {
		if (msg.role === 'system') continue;

		if (msg.role === 'user') {
			flush();
			const { text, images } = textOf(msg.content);
			out.push({
				id: String(msg.id ?? uid('u')),
				role: 'user',
				content: text,
				images,
				steps: [],
				reasoning: '',
				streaming: false,
				timestamp: msg.timestamp ?? Date.now() / 1000
			});
			continue;
		}

		if (!current) {
			current = {
				id: String(msg.id ?? uid('a')),
				role: 'assistant',
				content: '',
				images: [],
				steps: [],
				reasoning: '',
				streaming: false,
				timestamp: msg.timestamp ?? Date.now() / 1000
			};
		}

		if (msg.role === 'tool') {
			const { text } = textOf(msg.content);
			current.steps.push({
				key: String(msg.tool_call_id ?? uid('t')),
				// Left empty on purpose when upstream has no name: the merge
				// below then keeps the one the tool_calls row already gave.
				tool_name: msg.tool_name || '',
				status: 'done',
				result: text.slice(0, 4000),
				started_at: msg.timestamp ?? Date.now() / 1000
			});
			continue;
		}

		// assistant
		// Not `msg.tool_calls ?? []`: the column is JSON we did not write, and a
		// row holding a string there would make `for…of` walk its characters.
		const calls: Array<HermesToolCall | null | undefined> = Array.isArray(msg.tool_calls)
			? msg.tool_calls
			: [];
		for (const call of calls) {
			const name = call?.function?.name || call?.name;
			if (!name) continue;
			current.steps.push({
				key: String(call.id ?? uid('t')),
				tool_name: name,
				status: 'done',
				args: call.function?.arguments ?? call.arguments,
				started_at: msg.timestamp ?? Date.now() / 1000
			});
		}
		const reasoning = msg.reasoning || msg.reasoning_content;
		if (reasoning) current.reasoning += reasoning;
		const { text } = textOf(msg.content);
		// Intermediate assistant turns (the ones that only carry tool_calls)
		// have empty content, so the last non-empty one wins the bubble.
		if (text) current.content = current.content ? `${current.content}\n\n${text}` : text;
	}
	flush();

	// Merge duplicate step keys that both the tool_calls row and the tool
	// result row produced, keeping the result — and the name, which the tool
	// row does not always carry (Hermes writes `name` but not `tool_name` on
	// the rows it synthesises for invalid tool calls, and its row decoder
	// drops the column when it is NULL).
	for (const turn of out) {
		const seen = new Map<string, ToolStep>();
		for (const step of turn.steps) {
			const prev = seen.get(step.key);
			if (prev) {
				Object.assign(prev, {
					...step,
					tool_name: step.tool_name || prev.tool_name,
					result: step.result ?? prev.result
				});
			} else seen.set(step.key, step);
		}
		turn.steps = [...seen.values()];
		// An orphan tool row (no matching tool_calls entry) still needs a label.
		for (const step of turn.steps) if (!step.tool_name) step.tool_name = 'tool';
	}

	return out;
}

/**
 * Rows the browser loads for a conversation in one go.
 *
 * It is the ceiling upstream enforces too (`_handle_session_messages` clamps
 * any `limit` to 500), so it cannot be raised from here — a longer transcript
 * is read page by page with `loadOlderHistory()`.
 */
export const TRANSCRIPT_PAGE = 500;

/**
 * Prepend an older page of rows to the window already loaded.
 *
 * Upstream pages `order=latest` backwards from the *newest* row, so an offset
 * taken from what we hold goes stale the moment Hermes persists another row —
 * which it does on every turn. A page fetched while a turn was writing
 * therefore overlaps the window we already have, and a repeated row id is not
 * a cosmetic defect: the thread renders `{#each … (message.id)}`, where a
 * duplicate key throws. Hence the merge is by id rather than a splice, and
 * rows upstream gave no id through are kept (`groupTranscript` hands those a
 * unique `uid()` anyway).
 */
export function mergeOlderRows(older: HermesMessage[], loaded: HermesMessage[]): HermesMessage[] {
	const known = new Set<string>();
	for (const row of loaded) if (row.id !== undefined && row.id !== null) known.add(String(row.id));
	const fresh = older.filter(
		(row) => row.id === undefined || row.id === null || !known.has(String(row.id))
	);
	return fresh.length ? [...fresh, ...loaded] : loaded;
}

/**
 * Which drawn icon stands for a Hermes tool family.
 *
 * Returns a name from `$lib/icons`, not a glyph: an emoji is drawn by the
 * platform's own font, so the same timeline looked different on the phone and
 * on the desktop and took colours no palette had a say over.
 */
export function toolIcon(name: string): IconName {
	if (name.startsWith('mcp_')) return 'plug';
	if (name === '_thinking') return 'thought';
	if (name.startsWith('browser')) return 'globe';
	// `web_search`, but also `session_search` and `x_search`, which would
	// otherwise fall into the file family below on their `search` substring.
	if (name.startsWith('web_') || name.endsWith('_search')) return 'search';
	if (name === 'terminal' || name === 'process') return 'terminal';
	if (name.includes('code')) return 'code';
	if (['read', 'write', 'patch', 'search', 'file'].some((f) => name.includes(f))) return 'file';
	if (name.includes('memory')) return 'layers';
	if (name.includes('image')) return 'image';
	if (name.includes('todo')) return 'checkSquare';
	if (name.includes('cron')) return 'clock';
	if (name.includes('delegat')) return 'users';
	return 'wrench';
}

/** Human label for an MCP tool: mcp_<server>_<tool> -> "server · tool". */
export function toolLabel(name: string): string {
	if (name.startsWith('mcp_')) {
		const rest = name.slice(4);
		const idx = rest.indexOf('_');
		if (idx > 0) return `${rest.slice(0, idx)} · ${rest.slice(idx + 1)}`;
	}
	return name;
}
