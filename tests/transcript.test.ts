import test from 'node:test';
import assert from 'node:assert/strict';
import {
	TRANSCRIPT_PAGE,
	emptyAssistant,
	groupTranscript,
	mergeOlderRows,
	toolIcon,
	toolLabel,
	uid
} from '../src/lib/transcript.ts';
import { methodBody, source } from './source.ts';
import type { HermesMessage, HermesToolCall } from '../src/lib/types.ts';

// Shorthand: the transcript rows Hermes actually returns are sparse, so tests
// build them field by field rather than from a fat fixture.
const m = (msg: Partial<HermesMessage> & { role: HermesMessage['role'] }): HermesMessage =>
	msg as HermesMessage;

test('an empty transcript folds to nothing', () => {
	assert.deepEqual(groupTranscript([]), []);
});

test('system rows never reach the UI', () => {
	const out = groupTranscript([
		m({ role: 'system', content: 'Tu es Hermes.' }),
		m({ role: 'user', content: 'salut' })
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].role, 'user');
});

test('a plain exchange becomes two settled turns', () => {
	const out = groupTranscript([
		m({ id: 1, role: 'user', content: 'quelle heure ?', timestamp: 100 }),
		m({ id: 2, role: 'assistant', content: 'Il est midi.', timestamp: 101 })
	]);
	assert.equal(out.length, 2);
	assert.deepEqual(
		out.map((t) => [t.id, t.role, t.content, t.streaming, t.timestamp]),
		[
			['1', 'user', 'quelle heure ?', false, 100],
			['2', 'assistant', 'Il est midi.', false, 101]
		]
	);
	// Nothing reloaded is ever mid-flight: a reload that left `streaming` on
	// would show a caret blinking forever on a finished answer.
	assert.equal(
		out.every((t) => t.streaming === false && t.detached === undefined),
		true
	);
});

test('a row without id or timestamp still gets both', () => {
	const [turn] = groupTranscript([m({ role: 'user', content: 'salut' })]);
	assert.equal(typeof turn.id, 'string');
	assert.notEqual(turn.id, '');
	assert.equal(Number.isFinite(turn.timestamp), true);
});

test('multimodal user content splits into text and images', () => {
	const [turn] = groupTranscript([
		m({
			role: 'user',
			content: [
				{ type: 'text', text: 'regarde' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
				{ type: 'text', text: 'et dis-moi' }
			]
		})
	]);
	assert.equal(turn.content, 'regarde\net dis-moi');
	assert.deepEqual(turn.images, ['data:image/png;base64,AAA']);
});

test('malformed content parts are skipped rather than thrown on', () => {
	const [turn] = groupTranscript([
		m({
			role: 'user',
			content: [
				null,
				'texte nu',
				{ type: 'image_url' },
				{ type: 'image_url', image_url: {} },
				{ type: 'text' },
				{ type: 'text', text: 'ok' }
			] as HermesMessage['content']
		})
	]);
	assert.equal(turn.content, 'ok');
	assert.deepEqual(turn.images, []);
});

test('null and absent content read as empty', () => {
	const out = groupTranscript([m({ role: 'user', content: null }), m({ role: 'user' })]);
	assert.deepEqual(
		out.map((t) => t.content),
		['', '']
	);
});

test('a tool round trip collapses into one step carrying args and result', () => {
	const out = groupTranscript([
		m({ role: 'user', content: 'liste /tmp', timestamp: 10 }),
		m({
			role: 'assistant',
			content: '',
			timestamp: 11,
			tool_calls: [{ id: 'call_1', function: { name: 'terminal', arguments: '{"cmd":"ls /tmp"}' } }]
		}),
		m({ role: 'tool', tool_call_id: 'call_1', tool_name: 'terminal', content: 'a.txt', timestamp: 12 }),
		m({ role: 'assistant', content: 'Il y a a.txt.', timestamp: 13 })
	]);

	assert.equal(out.length, 2);
	const answer = out[1];
	assert.equal(answer.role, 'assistant');
	assert.equal(answer.content, 'Il y a a.txt.');
	assert.equal(answer.steps.length, 1);
	assert.deepEqual(answer.steps[0], {
		key: 'call_1',
		tool_name: 'terminal',
		status: 'done',
		args: '{"cmd":"ls /tmp"}',
		result: 'a.txt',
		started_at: 12
	});
});

test('a nameless tool result does not erase the name from the tool call', () => {
	// Hermes synthesises tool rows with `name` but no `tool_name` for invalid
	// tool calls, and its row decoder omits the column when it is NULL. The
	// merge used to overwrite "terminal" with the generic "tool" fallback.
	const [turn] = groupTranscript([
		m({
			role: 'assistant',
			tool_calls: [{ id: 'call_1', function: { name: 'terminal', arguments: '{}' } }]
		}),
		m({ role: 'tool', tool_call_id: 'call_1', content: 'Error: invalid tool name.' })
	]);
	assert.equal(turn.steps[0].tool_name, 'terminal');
	assert.equal(turn.steps[0].result, 'Error: invalid tool name.');
});

test('an orphan tool row still gets a label', () => {
	const [turn] = groupTranscript([
		m({ role: 'tool', tool_call_id: 'call_9', content: 'résultat sans appel' })
	]);
	assert.equal(turn.role, 'assistant');
	assert.equal(turn.steps[0].tool_name, 'tool');
	assert.equal(turn.steps[0].result, 'résultat sans appel');
});

test('step keys stay unique inside a turn', () => {
	// ToolSteps.svelte renders `{#each steps as step (step.key)}`: a duplicate
	// key is a hard runtime failure, so this is not a cosmetic property.
	const [turn] = groupTranscript([
		m({
			role: 'assistant',
			tool_calls: [
				{ id: 'call_1', function: { name: 'read_file' } },
				{ id: 'call_1', function: { name: 'read_file' } },
				{ function: { name: 'write_file' } },
				{ function: { name: 'write_file' } }
			]
		}),
		m({ role: 'tool', content: 'sans tool_call_id' }),
		m({ role: 'tool', content: 'sans tool_call_id non plus' })
	]);
	const keys = turn.steps.map((s) => s.key);
	assert.equal(new Set(keys).size, keys.length);
});

test('tool_calls entries without a name are dropped, junk tool_calls ignored', () => {
	const [turn] = groupTranscript([
		m({
			role: 'assistant',
			content: 'ok',
			tool_calls: [{ id: 'a', function: {} }, { id: 'b', name: 'todo' }, { id: 'c' }]
		})
	]);
	// `name` at the top level is the shape some providers emit; it counts too.
	assert.deepEqual(
		turn.steps.map((s) => s.tool_name),
		['todo']
	);

	const [other] = groupTranscript([
		m({ role: 'assistant', content: 'ok', tool_calls: 'nope' as unknown as HermesToolCall[] })
	]);
	assert.deepEqual(other.steps, []);
});

test('a huge tool result is truncated', () => {
	const [turn] = groupTranscript([
		m({ role: 'tool', tool_call_id: 't', tool_name: 'terminal', content: 'x'.repeat(9000) })
	]);
	assert.equal(turn.steps[0].result?.length, 4000);
});

test('several assistant text rows join into one bubble', () => {
	const [turn] = groupTranscript([
		m({ role: 'assistant', content: 'Je regarde.', tool_calls: [{ id: 'c', function: { name: 'terminal' } }] }),
		m({ role: 'tool', tool_call_id: 'c', tool_name: 'terminal', content: 'ok' }),
		m({ role: 'assistant', content: 'Voilà.' })
	]);
	assert.equal(turn.content, 'Je regarde.\n\nVoilà.');
	assert.equal(turn.steps.length, 1);
});

test('reasoning accumulates from both field names', () => {
	const [turn] = groupTranscript([
		m({ role: 'assistant', reasoning: 'je pense…' }),
		m({ role: 'assistant', reasoning_content: 'puis je conclus.', content: 'Fini.' })
	]);
	assert.equal(turn.reasoning, 'je pense…puis je conclus.');
	assert.equal(turn.content, 'Fini.');
});

test('a new user row closes the assistant turn, in order', () => {
	const out = groupTranscript([
		m({ role: 'user', content: 'un' }),
		m({ role: 'assistant', content: 'deux' }),
		m({ role: 'user', content: 'trois' }),
		m({ role: 'assistant', content: 'quatre' })
	]);
	assert.deepEqual(
		out.map((t) => `${t.role}:${t.content}`),
		['user:un', 'assistant:deux', 'user:trois', 'assistant:quatre']
	);
});

test('two user rows in a row do not invent an assistant turn', () => {
	const out = groupTranscript([
		m({ role: 'user', content: 'un' }),
		m({ role: 'user', content: 'deux' })
	]);
	assert.deepEqual(
		out.map((t) => t.role),
		['user', 'user']
	);
});

test('a transcript ending on a tool row still yields its turn', () => {
	const out = groupTranscript([
		m({ role: 'user', content: 'vas-y' }),
		m({ role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'terminal' } }] }),
		m({ role: 'tool', tool_call_id: 'c', tool_name: 'terminal', content: 'en cours' })
	]);
	assert.equal(out.length, 2);
	assert.equal(out[1].content, '');
	assert.equal(out[1].steps.length, 1);
});

test('toolIcon covers the real Hermes tool families', () => {
	// Names from `$lib/icons`, not glyphs: an emoji is drawn by whatever font
	// the platform ships, which is why the timeline used to look different on
	// the phone and on the desktop.
	const expected: Record<string, string> = {
		mcp_github_create_issue: 'plug',
		_thinking: 'thought',
		browser_navigate: 'globe',
		web_search: 'search',
		web_extract: 'search',
		x_search: 'search',
		session_search: 'search',
		terminal: 'terminal',
		process: 'terminal',
		execute_code: 'code',
		read_file: 'file',
		write_file: 'file',
		patch: 'file',
		search_files: 'file',
		memory_store: 'layers',
		generate_image: 'image',
		todo: 'checkSquare',
		cron_add: 'clock',
		delegate_task: 'users',
		something_else: 'wrench',
		'': 'wrench'
	};
	for (const [name, icon] of Object.entries(expected)) {
		assert.equal(toolIcon(name), icon, `${name || '(vide)'} devrait afficher ${icon}`);
	}
});

test('toolLabel splits an MCP name, and leaves everything else alone', () => {
	assert.equal(toolLabel('mcp_github_create_issue'), 'github · create_issue');
	assert.equal(toolLabel('terminal'), 'terminal');
	// No server/tool boundary to find: better the raw name than a truncation.
	assert.equal(toolLabel('mcp_github'), 'mcp_github');
	assert.equal(toolLabel('mcp_github_'), 'github · ');
	assert.equal(toolLabel('mcp__leading'), 'mcp__leading');
	assert.equal(toolLabel(''), '');
});

test('uid never repeats inside one tick', () => {
	const ids = Array.from({ length: 500 }, () => uid('t'));
	assert.equal(new Set(ids).size, 500);
	assert.equal(
		ids.every((id) => id.startsWith('t_')),
		true
	);
});

test('emptyAssistant is a blank streaming bubble with its own id', () => {
	const a = emptyAssistant();
	const b = emptyAssistant();
	assert.notEqual(a.id, b.id);
	assert.equal(a.role, 'assistant');
	assert.equal(a.content, '');
	assert.equal(a.streaming, true);
	assert.deepEqual(a.steps, []);
	assert.deepEqual(a.images, []);
	assert.equal(a.reasoning, '');
	assert.equal(a.detached, undefined);
});

/**
 * Paging a transcript backwards.
 *
 * Upstream reads a page of messages from whichever end the request names and
 * caps it at 500 rows — **measured** against the running gateway on a 41-row
 * conversation: `order=oldest&limit=5` gives rows 230…236, `order=latest`
 * gives 273…277, `order=latest&offset=5` the five before those. The thread
 * asked for `oldest`, so a conversation past the ceiling opened on its
 * beginning with everything recent missing.
 */

test('TRANSCRIPT_PAGE is the ceiling upstream enforces', () => {
	// `_handle_session_messages` clamps with `min(requested_limit, 500)`:
	// asking for more would silently get this anyway.
	assert.equal(TRANSCRIPT_PAGE, 500);
});

test('an older page lands in front of the window', () => {
	const older = [m({ id: 1, role: 'user' }), m({ id: 2, role: 'assistant' })];
	const window = [m({ id: 3, role: 'user' }), m({ id: 4, role: 'assistant' })];
	assert.deepEqual(
		mergeOlderRows(older, window).map((r) => r.id),
		[1, 2, 3, 4]
	);
});

test('a row the window already holds is not added twice', () => {
	// Upstream pages back from the NEWEST row, so a turn persisted while the
	// reader was elsewhere shifts the offset and the page overlaps. A repeated
	// id would throw in the keyed `{#each}` that renders the thread.
	const window = [m({ id: 3, role: 'user' }), m({ id: 4, role: 'assistant' })];
	const older = [m({ id: 2, role: 'assistant' }), m({ id: 3, role: 'user' })];
	const merged = mergeOlderRows(older, window);
	assert.deepEqual(
		merged.map((r) => r.id),
		[2, 3, 4]
	);
	assert.equal(new Set(merged.map((r) => String(r.id))).size, merged.length);
});

test('a fully overlapping page leaves the window untouched', () => {
	const window = [m({ id: 7, role: 'user' })];
	assert.equal(mergeOlderRows([m({ id: 7, role: 'user' })], window), window);
	assert.equal(mergeOlderRows([], window), window);
});

test('rows upstream gave no id through are kept', () => {
	// `groupTranscript` hands those a unique `uid()`, so they cannot collide.
	const merged = mergeOlderRows([m({ role: 'user' }), m({ role: 'assistant' })], [
		m({ id: 9, role: 'user' })
	]);
	assert.equal(merged.length, 3);
	assert.deepEqual(
		merged.map((r) => r.id),
		[undefined, undefined, 9]
	);
});

test('merging an older page folds into one transcript', () => {
	// The point of re-folding the whole window rather than grouping the page on
	// its own: a boundary falling inside a turn heals once the older rows land.
	const window = [m({ id: 3, role: 'tool', tool_call_id: 'c1', content: 'ok' })];
	const older = [
		m({ id: 1, role: 'user', content: 'liste' }),
		m({
			id: 2,
			role: 'assistant',
			tool_calls: [{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{}' } }]
		})
	];
	const split = groupTranscript(window);
	assert.equal(split.length, 1);
	assert.equal(split[0].steps[0].tool_name, 'tool', 'an orphan tool row has no name to show');

	const whole = groupTranscript(mergeOlderRows(older, window));
	assert.equal(whole.length, 2);
	assert.equal(whole[1].steps.length, 1);
	assert.equal(whole[1].steps[0].tool_name, 'terminal');
	assert.equal(whole[1].steps[0].result, 'ok');
});

test('the thread and the cross-conversation search both read the newest page', () => {
	const store = source('src/lib/stores/chat.svelte.ts');
	for (const name of ['async openSession(', 'async loadOlderHistory()']) {
		const body = methodBody(store, name);
		assert.match(body, /order=latest/, `${name} must read from the newest end`);
		assert.doesNotMatch(
			body,
			/order=oldest/,
			`${name} would open a long conversation on its beginning`
		);
	}
	// Same window as the thread, so a hit's id is the `data-mid` the browser
	// will scroll to — searching the other end would both miss the recent half
	// and hand back ids the open thread never renders.
	const search = source('src/lib/server/search.ts');
	assert.match(search, /TRANSCRIPT_ORDER = 'latest'/);
	assert.doesNotMatch(search, /order: 'oldest'/);
});

test('the live tail survives loading an older page', () => {
	// A turn sent since the window loaded exists only in `messages`; re-folding
	// `#rows` over it would erase the exchange that just happened.
	const body = methodBody(source('src/lib/stores/chat.svelte.ts'), '#showWindow()');
	assert.match(body, /this\.messages\.slice\(this\.#folded\)/);
	assert.match(body, /\.\.\.folded, \.\.\.live/);
});
