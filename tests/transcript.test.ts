import test from 'node:test';
import assert from 'node:assert/strict';
import {
	emptyAssistant,
	groupTranscript,
	hasOlderRows,
	toolIcon,
	toolLabel,
	TRANSCRIPT_PAGE,
	transcriptQuery,
	uid
} from '../src/lib/transcript.ts';
import type { HermesMessage, HermesToolCall } from '../src/lib/types.ts';
import { methodBody, source } from './source.ts';

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

// ---------------------------------------------------------------------------
// Which page of a transcript a request brings back
// ---------------------------------------------------------------------------

test('session_meta rows are bookkeeping, not conversation', () => {
	// Hermes writes one of these to record the runtime of a stretch of
	// conversation; its content is a JSON object, not text. Every other
	// consumer drops them by name, and folding one opened a bubble that then
	// lent its row id to the assistant turn that followed.
	const out = groupTranscript([
		m({ id: 1, role: 'user', content: 'salut' }),
		m({ id: 2, role: 'session_meta', content: null }),
		m({ id: 3, role: 'assistant', content: 'Bonjour.' })
	]);
	assert.equal(out.length, 2);
	assert.deepEqual(
		out.map((t) => [t.role, t.id, t.content]),
		[
			['user', '1', 'salut'],
			['assistant', '3', 'Bonjour.']
		]
	);
});

test('a session_meta row between two turns does not leave an empty bubble', () => {
	const out = groupTranscript([
		m({ id: 1, role: 'user', content: 'a' }),
		m({ id: 2, role: 'assistant', content: 'A' }),
		m({ id: 3, role: 'session_meta', content: { model: 'gpt-4' } as never }),
		m({ id: 4, role: 'user', content: 'b' })
	]);
	assert.deepEqual(
		out.map((t) => t.role),
		['user', 'assistant', 'user']
	);
});

test('an unknown future role is skipped rather than rendered as the agent', () => {
	const out = groupTranscript([
		m({ id: 1, role: 'telemetry', content: 'nothing to read here' }),
		m({ id: 2, role: 'user', content: 'salut' })
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0].role, 'user');
});

test('the first page asked for is the LATEST one, at the upstream ceiling', () => {
	const q = new URLSearchParams(transcriptQuery());
	// `oldest` here would show the opening of a long conversation and hide its
	// end — including the answer `reload()` exists to fetch.
	assert.equal(q.get('order'), 'latest');
	assert.equal(q.get('limit'), '500');
	assert.equal(q.get('offset'), null);
	assert.equal(TRANSCRIPT_PAGE, 500);
});

test('an offset pages backwards from the newest row', () => {
	const q = new URLSearchParams(transcriptQuery(500));
	assert.equal(q.get('order'), 'latest');
	assert.equal(q.get('offset'), '500');
});

test('a nonsense offset cannot become a negative or fractional one', () => {
	assert.equal(new URLSearchParams(transcriptQuery(-7)).get('offset'), null);
	assert.equal(new URLSearchParams(transcriptQuery(12.6)).get('offset'), '12');
	assert.equal(new URLSearchParams(transcriptQuery(NaN)).get('offset'), null);
});

test('a full page means older rows may exist, a short one means the start', () => {
	assert.equal(hasOlderRows({ data: [], pagination: { limit: 500, returned: 500 } }), true);
	assert.equal(hasOlderRows({ data: [], pagination: { limit: 500, returned: 499 } }), false);
	assert.equal(hasOlderRows({ data: [], pagination: { limit: 500, returned: 0 } }), false);
});

test('a missing pagination block falls back to counting the rows', () => {
	const rows = Array.from({ length: 500 }, (_, i) => m({ id: i, role: 'user' }));
	assert.equal(hasOlderRows({ data: rows }), true);
	assert.equal(hasOlderRows({ data: rows.slice(1) }), false);
	assert.equal(hasOlderRows({}), false);
	// A zero or absent `limit` must not make every page look full.
	assert.equal(hasOlderRows({ data: rows, pagination: { limit: 0, returned: 500 } }), true);
	assert.equal(hasOlderRows({ data: [], pagination: { limit: 0, returned: 0 } }), false);
});

test('the thread and the cross-conversation search read the same end', () => {
	// A hit is only useful because the thread can scroll to it, and it can only
	// scroll to a message it has loaded. If these two ever name different ends
	// of a long transcript, every hit in the half the thread does not hold
	// points at a `data-mid` that never reaches the DOM.
	const store = methodBody(source('src/lib/stores/chat.svelte.ts'), 'async openSession(');
	assert.match(store, /transcriptQuery\(\)/);
	assert.doesNotMatch(store, /order=oldest/);

	const search = source('src/lib/server/search.ts');
	assert.match(search, /TRANSCRIPT_ORDER = 'latest'/);
	assert.match(search, /order: TRANSCRIPT_ORDER/);
	assert.doesNotMatch(search, /order: 'oldest'/);
});

test('pulling an older page re-groups the rows instead of splicing turns', () => {
	// A page boundary falls on an arbitrary row, so a turn's tool rows can
	// straddle it. Grouping the new page alone and putting it in front would
	// render that turn twice.
	const body = methodBody(source('src/lib/stores/chat.svelte.ts'), 'async loadOlderMessages(');
	assert.match(body, /groupTranscript\(this\.#rows\)/);
	// And it must stand down for a thread that holds a live turn: those
	// messages are not in `#rows`, so re-grouping would drop them.
	assert.match(body, /this\.streaming/);
	assert.match(
		methodBody(source('src/lib/stores/chat.svelte.ts'), 'async send('),
		/this\.olderMessages = false/
	);
});

test('a turn straddling a page boundary survives folding, not splicing', () => {
	// Why `loadOlderMessages()` re-folds the accumulated rows instead of
	// folding the new page on its own and putting it in front. A page boundary
	// falls on an arbitrary row id, so the assistant row carrying `tool_calls`
	// can sit on the older page while its tool result sits on the newer one.
	const rows = [
		m({ id: 1, role: 'user', content: 'run it' }),
		m({
			id: 2,
			role: 'assistant',
			content: '',
			tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }] as HermesToolCall[]
		}),
		m({ id: 3, role: 'tool', tool_call_id: 'c1', tool_name: 'terminal', content: 'done' }),
		m({ id: 4, role: 'assistant', content: 'It ran.' })
	];
	const older = rows.slice(0, 2);
	const newer = rows.slice(2);

	const spliced = [...groupTranscript(older), ...groupTranscript(newer)];
	assert.equal(spliced.filter((t) => t.role === 'assistant').length, 2);

	const folded = groupTranscript([...older, ...newer]);
	assert.equal(folded.length, 2);
	assert.equal(folded[1].content, 'It ran.');
	assert.equal(folded[1].steps.length, 1);
	assert.equal(folded[1].steps[0].tool_name, 'terminal');
	assert.equal(folded[1].steps[0].result, 'done');
	// And it is the same thing one unpaged load would have produced.
	assert.deepEqual(folded, groupTranscript(rows));
});
