import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_AGENTS,
	MAX_AGENT_CHILDREN,
	MAX_AGENT_NAME,
	MAX_AGENT_PROMPT,
	CHILD_BRIEF_CHARS,
	agentFromDraft,
	agentSlug,
	composeSystemPrompt,
	directReports,
	draftFromBody,
	duplicateDraft,
	normalizeAgents,
	normalizeEmoji,
	starterAgents,
	teamCycle,
	teamTree,
	validateAgent,
	type Agent,
	type AgentDraft
} from '../src/lib/agents.ts';

function agent(id: string, over: Partial<Agent> = {}): Agent {
	return {
		id,
		name: id,
		emoji: '',
		color: '',
		role: '',
		prompt: `prompt de ${id}`,
		model: '',
		orchestrator: false,
		children: [],
		created_at: 1,
		updated_at: 1,
		...over
	};
}

const draft = (over: Partial<AgentDraft> = {}): AgentDraft => ({
	name: 'Nouveau',
	emoji: '',
	color: 'azur',
	role: '',
	prompt: 'fais des choses',
	model: '',
	orchestrator: false,
	children: [],
	...over
});

// ---------------------------------------------------------------------------
// normalizeAgents
// ---------------------------------------------------------------------------

test('normalizeAgents ignores anything that is not a list', () => {
	assert.deepEqual(normalizeAgents(null), []);
	assert.deepEqual(normalizeAgents('nope'), []);
	assert.deepEqual(normalizeAgents({ a: 1 }), []);
});

test('normalizeAgents drops rows without an id or a name', () => {
	const list = normalizeAgents([
		{ id: '', name: 'sans id' },
		{ id: 'x', name: '   ' },
		{ id: 'ok', name: 'Bon' }
	]);
	assert.deepEqual(
		list.map((a) => a.id),
		['ok']
	);
});

test('normalizeAgents keeps the first of two rows sharing an id', () => {
	const list = normalizeAgents([
		{ id: 'a', name: 'Premier' },
		{ id: 'a', name: 'Second' }
	]);
	assert.equal(list.length, 1);
	assert.equal(list[0].name, 'Premier');
});

test('normalizeAgents clips every bounded field', () => {
	const [a] = normalizeAgents([
		{
			id: 'a',
			name: 'n'.repeat(200),
			role: 'r'.repeat(300),
			prompt: 'p'.repeat(MAX_AGENT_PROMPT + 500)
		}
	]);
	assert.equal(a.name.length, MAX_AGENT_NAME);
	assert.ok(a.role.length <= 80);
	assert.equal(a.prompt.length, MAX_AGENT_PROMPT);
});

test('normalizeAgents caps the roster', () => {
	const raw = Array.from({ length: MAX_AGENTS + 10 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
	assert.equal(normalizeAgents(raw).length, MAX_AGENTS);
});

test('normalizeAgents caps and de-duplicates the team', () => {
	const [a] = normalizeAgents([
		{ id: 'a', name: 'A', children: ['b', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
		...['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => ({ id, name: id }))
	]);
	assert.equal(a.children.length, MAX_AGENT_CHILDREN);
	assert.equal(new Set(a.children).size, a.children.length);
});

test('normalizeAgents prunes references to agents that no longer exist', () => {
	const [a] = normalizeAgents([{ id: 'a', name: 'A', children: ['ghost', 'b'] }, { id: 'b', name: 'B' }]);
	assert.deepEqual(a.children, ['b']);
});

test('normalizeAgents refuses a self-reference', () => {
	const [a] = normalizeAgents([{ id: 'a', name: 'A', children: ['a'] }]);
	assert.deepEqual(a.children, []);
});

test('normalizeAgents breaks a loop rather than keeping it', () => {
	const list = normalizeAgents([
		{ id: 'a', name: 'A', orchestrator: true, children: ['b'] },
		{ id: 'b', name: 'B', orchestrator: true, children: ['c'] },
		{ id: 'c', name: 'C', orchestrator: true, children: ['a'] }
	]);
	assert.equal(teamCycle(list, 'a'), null);
	assert.equal(teamCycle(list, 'b'), null);
	assert.equal(teamCycle(list, 'c'), null);
	// Only the closing edge goes: the chain itself survives.
	assert.deepEqual(list.find((a) => a.id === 'a')!.children, ['b']);
	assert.deepEqual(list.find((a) => a.id === 'c')!.children, []);
});

test('normalizeAgents only keeps a colour from the palette', () => {
	const [a, b] = normalizeAgents([
		{ id: 'a', name: 'A', color: 'vert' },
		{ id: 'b', name: 'B', color: 'javascript:alert(1)' }
	]);
	assert.equal(a.color, 'vert');
	assert.equal(b.color, '');
});

test('normalizeEmoji keeps a whole emoji, never half a surrogate pair', () => {
	assert.equal(normalizeEmoji('🔎'), '🔎');
	assert.equal(normalizeEmoji('  🛠️  '), '🛠️');
	assert.equal(normalizeEmoji('abcdefgh'), 'abc');
	assert.equal(normalizeEmoji(42), '');
	// A lone high surrogate would be an unpaired code unit; slicing by code
	// point cannot produce one.
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(normalizeEmoji('👨‍👩‍👧‍👦')));
});

// ---------------------------------------------------------------------------
// Cycles and trees
// ---------------------------------------------------------------------------

test('teamCycle returns null on a plain hierarchy', () => {
	const list = [
		agent('chef', { orchestrator: true, children: ['a', 'b'] }),
		agent('a'),
		agent('b')
	];
	assert.equal(teamCycle(list, 'chef'), null);
});

test('teamCycle names the whole loop', () => {
	const list = [
		agent('a', { children: ['b'] }),
		agent('b', { children: ['c'] }),
		agent('c', { children: ['a'] })
	];
	assert.deepEqual(teamCycle(list, 'a'), ['a', 'b', 'c', 'a']);
});

test('teamCycle finds a loop that does not include the start', () => {
	const list = [
		agent('root', { children: ['a'] }),
		agent('a', { children: ['b'] }),
		agent('b', { children: ['a'] })
	];
	assert.deepEqual(teamCycle(list, 'root'), ['a', 'b', 'a']);
});

test('teamCycle survives a diamond without calling it a loop', () => {
	const list = [
		agent('root', { children: ['a', 'b'] }),
		agent('a', { children: ['leaf'] }),
		agent('b', { children: ['leaf'] }),
		agent('leaf')
	];
	assert.equal(teamCycle(list, 'root'), null);
});

test('teamTree walks orchestrators depth-first and stops at leaves', () => {
	const list = [
		agent('chef', { orchestrator: true, children: ['sous', 'solo'] }),
		agent('sous', { orchestrator: true, children: ['petit'] }),
		agent('petit'),
		// A leaf's children are ignored: delegate_task strips the delegation
		// toolset from a leaf child, so it physically cannot pilot anyone.
		agent('solo', { children: ['petit'] })
	];
	assert.deepEqual(
		teamTree(list, 'chef').map((n) => [n.agent.id, n.depth]),
		[
			['chef', 0],
			['sous', 1],
			['petit', 2],
			['solo', 1]
		]
	);
});

test('teamTree honours its depth limit', () => {
	const list = [
		agent('a', { orchestrator: true, children: ['b'] }),
		agent('b', { orchestrator: true, children: ['c'] }),
		agent('c', { orchestrator: true, children: ['d'] }),
		agent('d')
	];
	assert.equal(teamTree(list, 'a', 1).length, 2);
	assert.equal(teamTree(list, 'a', 3).length, 4);
});

test('teamTree marks a repeat instead of looping forever', () => {
	// Hand-built cycle, as a corrupt row would produce: the tree must terminate.
	const list = [
		agent('a', { orchestrator: true, children: ['b'] }),
		agent('b', { orchestrator: true, children: ['a'] })
	];
	const tree = teamTree(list, 'a', 10);
	assert.ok(tree.length <= 3);
	assert.equal(tree.at(-1)!.repeated, true);
});

test('directReports is empty for a non-orchestrator', () => {
	const list = [agent('a', { children: ['b'] }), agent('b')];
	assert.deepEqual(directReports(list, list[0]), []);
	list[0].orchestrator = true;
	assert.deepEqual(
		directReports(list, list[0]).map((a) => a.id),
		['b']
	);
});

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

test('composeSystemPrompt returns nothing for an unknown agent', () => {
	assert.equal(composeSystemPrompt([agent('a')], 'nope'), '');
});

test('composeSystemPrompt of a leaf is the persona alone', () => {
	const list = [agent('a', { name: 'Chercheur', role: 'Recherche web', prompt: 'Cite tes sources.' })];
	const out = composeSystemPrompt(list, 'a');
	assert.equal(out, 'You are Chercheur.\nYour role: Recherche web\n\nCite tes sources.');
	assert.ok(!out.includes('delegate_task'));
});

test('composeSystemPrompt ignores a team when the agent does not orchestrate', () => {
	const list = [agent('chef', { children: ['a'] }), agent('a', { name: 'Alice' })];
	const out = composeSystemPrompt(list, 'chef');
	assert.ok(!out.includes('Alice'));
	assert.ok(!out.includes('delegate_task'));
});

test('composeSystemPrompt briefs an orchestrator on each teammate', () => {
	const list = [
		agent('chef', { name: "Chef", role: 'Coordination', prompt: 'Découpe.', orchestrator: true, children: ['a', 'b'] }),
		agent('a', { name: 'Alice', role: 'Recherche', prompt: 'Cite tes sources.' }),
		agent('b', { name: 'Bob', role: 'Système', prompt: 'Mesure avant de conclure.' })
	];
	const out = composeSystemPrompt(list, 'chef');
	assert.ok(out.startsWith('You are Chef.\nYour role: Coordination'));
	assert.ok(out.includes('Découpe.'));
	assert.ok(out.includes('### Alice — Recherche'));
	assert.ok(out.includes('Cite tes sources.'));
	assert.ok(out.includes('### Bob — Système'));
	assert.ok(out.includes('Mesure avant de conclure.'));
	assert.ok(out.includes('delegate_task'));
	assert.ok(out.includes('"leaf"'));
});

test('composeSystemPrompt tells the leader which teammates may delegate in turn', () => {
	const list = [
		agent('chef', { name: 'Chef', orchestrator: true, children: ['sous'] }),
		agent('sous', { name: 'Sous-chef', orchestrator: true, children: ['petit'] }),
		agent('petit', { name: 'Petit' })
	];
	const out = composeSystemPrompt(list, 'chef');
	assert.ok(out.includes('Leads their own team: Petit.'));
	assert.ok(out.includes('role: "orchestrator"'));
});

test('composeSystemPrompt does not promise a sub-team a leaf cannot have', () => {
	const list = [
		agent('chef', { name: 'Chef', orchestrator: true, children: ['solo'] }),
		agent('solo', { name: 'Solo', orchestrator: false, children: ['petit'] }),
		agent('petit', { name: 'Petit' })
	];
	const out = composeSystemPrompt(list, 'chef');
	assert.ok(!out.includes('Leads their own team'));
});

test('composeSystemPrompt clips a long teammate brief', () => {
	const list = [
		agent('chef', { name: 'Chef', orchestrator: true, children: ['a'] }),
		agent('a', { name: 'Alice', prompt: 'x'.repeat(4000) })
	];
	const out = composeSystemPrompt(list, 'chef');
	const run = out.match(/x+/)![0];
	assert.ok(run.length < CHILD_BRIEF_CHARS + 1, `brief of ${run.length} chars`);
});

test('composeSystemPrompt skips a teammate that no longer exists', () => {
	const list = [agent('chef', { name: 'Chef', orchestrator: true, children: ['ghost'] })];
	const out = composeSystemPrompt(list, 'chef');
	assert.ok(!out.includes('Your team'));
});

test('composeSystemPrompt cannot loop on a corrupt roster', () => {
	const list = [
		agent('a', { name: 'A', orchestrator: true, children: ['b'] }),
		agent('b', { name: 'B', orchestrator: true, children: ['a'] })
	];
	const out = composeSystemPrompt(list, 'a');
	assert.ok(out.length < 20_000);
	assert.ok(out.includes('### B'));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateAgent demands a name and a prompt', () => {
	assert.ok(validateAgent([], null, draft({ name: '  ' })).length > 0);
	assert.ok(validateAgent([], null, draft({ prompt: '   ' })).length > 0);
	assert.deepEqual(validateAgent([], null, draft()), []);
});

test('validateAgent refuses a duplicate name, case-insensitively', () => {
	const list = [agent('a', { name: 'Alice' })];
	assert.ok(validateAgent(list, null, draft({ name: 'alice' })).length > 0);
	// Renaming an agent to what it already is stays legal.
	assert.deepEqual(validateAgent(list, 'a', draft({ name: 'Alice' })), []);
});

test('validateAgent refuses an agent that pilots itself', () => {
	const list = [agent('a', { name: 'A' })];
	const errors = validateAgent(list, 'a', draft({ name: 'A', orchestrator: true, children: ['a'] }));
	assert.ok(errors.some((e) => e.includes('cannot lead itself')));
});

test('validateAgent refuses a loop and names the chain', () => {
	const list = [
		agent('chef', { name: 'Chef', orchestrator: true, children: ['sous'] }),
		agent('sous', { name: 'Sous', orchestrator: true, children: [] })
	];
	const errors = validateAgent(
		list,
		'sous',
		draft({ name: 'Sous', orchestrator: true, children: ['chef'] })
	);
	assert.ok(errors.some((e) => e.startsWith('Loop in the team')), errors.join(' | '));
	assert.ok(errors.some((e) => e.includes('Chef')));
});

test('validateAgent catches a loop that closes several levels down', () => {
	const list = [
		agent('a', { name: 'A', orchestrator: true, children: ['b'] }),
		agent('b', { name: 'B', orchestrator: true, children: ['c'] }),
		agent('c', { name: 'C', orchestrator: true, children: [] })
	];
	const errors = validateAgent(list, 'c', draft({ name: 'C', orchestrator: true, children: ['a'] }));
	assert.ok(errors.some((e) => e.startsWith('Loop in the team')), errors.join(' | '));
});

test('validateAgent allows a diamond: two leaders, one shared specialist', () => {
	const list = [
		agent('chef1', { name: 'Chef 1', orchestrator: true, children: ['spec'] }),
		agent('spec', { name: 'Spec' })
	];
	assert.deepEqual(
		validateAgent(list, null, draft({ name: 'Chef 2', orchestrator: true, children: ['spec'] })),
		[]
	);
});

test('validateAgent ignores the team of a non-orchestrator when checking loops', () => {
	const list = [
		agent('a', { name: 'A', orchestrator: true, children: ['b'] }),
		agent('b', { name: 'B' })
	];
	assert.deepEqual(
		validateAgent(list, 'b', draft({ name: 'B', orchestrator: false, children: ['a'] })),
		[]
	);
});

test('validateAgent refuses a teammate that does not exist', () => {
	const errors = validateAgent([], null, draft({ orchestrator: true, children: ['ghost'] }));
	assert.ok(errors.some((e) => e.includes('no longer exists')));
});

test('validateAgent enforces the roster cap on creation only', () => {
	const list = Array.from({ length: MAX_AGENTS }, (_, i) => agent(`a${i}`, { name: `A${i}` }));
	assert.ok(validateAgent(list, null, draft()).length > 0);
	assert.deepEqual(validateAgent(list, 'a0', draft({ name: 'A0' })), []);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('draftFromBody trusts nothing', () => {
	const d = draftFromBody({ name: 12, children: ['a', 5, null], orchestrator: 'yes', prompt: 'ok' });
	assert.equal(d.name, '');
	assert.deepEqual(d.children, ['a']);
	assert.equal(d.orchestrator, false);
	assert.equal(d.prompt, 'ok');
});

test('agentFromDraft bounds what it produces and stamps the times', () => {
	const a = agentFromDraft(draft({ name: 'n'.repeat(90) }), 'id', 0, 1000);
	assert.ok(a);
	assert.equal(a!.id, 'id');
	assert.equal(a!.name.length, MAX_AGENT_NAME);
	assert.equal(a!.created_at, 1000);
	assert.equal(a!.updated_at, 1000);
});

test('agentFromDraft keeps the original creation date on an edit', () => {
	const a = agentFromDraft(draft(), 'id', 42, 1000);
	assert.equal(a!.created_at, 42);
	assert.equal(a!.updated_at, 1000);
});

test('duplicateDraft renames and keeps the team', () => {
	const source = agent('a', { name: 'Chef', orchestrator: true, children: ['b'] });
	const copy = duplicateDraft(source);
	assert.equal(copy.name, 'Chef (copy)');
	assert.deepEqual(copy.children, ['b']);
	// A separate array: editing the copy must not touch the original.
	copy.children.push('c');
	assert.deepEqual(source.children, ['b']);
});

test('agentSlug produces a usable id from any name', () => {
	assert.equal(agentSlug('Chef d’équipe', 'ab12'), 'chef-d-equipe-ab12');
	assert.equal(agentSlug('Créateur', 'ab12'), 'createur-ab12');
	assert.equal(agentSlug('🙂', 'ab12'), 'agent-ab12');
	assert.match(agentSlug('x'.repeat(100), 'ab12'), /^x{32}-ab12$/);
});

// ---------------------------------------------------------------------------
// The starter team
// ---------------------------------------------------------------------------

test('the starter team survives normalisation untouched', () => {
	const seed = starterAgents(1000);
	const normalized = normalizeAgents(seed);
	assert.equal(normalized.length, seed.length);
	assert.deepEqual(
		normalized.map((a) => a.id),
		seed.map((a) => a.id)
	);
	for (const a of normalized) assert.deepEqual(a.children, seed.find((s) => s.id === a.id)!.children);
});

test('the starter team has exactly one orchestrator, with real teammates', () => {
	const seed = normalizeAgents(starterAgents(1000));
	const leaders = seed.filter((a) => a.orchestrator);
	assert.equal(leaders.length, 1);
	assert.ok(leaders[0].children.length >= 2);
	assert.equal(teamCycle(seed, leaders[0].id), null);
	const out = composeSystemPrompt(seed, leaders[0].id);
	assert.ok(out.includes('delegate_task'));
});

test('every starter agent validates as if it had just been typed', () => {
	const seed = starterAgents(1000);
	for (const a of seed) {
		const others = seed.filter((s) => s.id !== a.id);
		assert.deepEqual(validateAgent(others.concat(a), a.id, { ...a }), [], a.name);
	}
});

test('a specialist piloted by two chiefs gets a unique key per position', () => {
	// `id + depth` collides here: Chercheur sits at depth 1 under both chiefs.
	// A repeated {#each} key throws at render time — invisible to check, tests
	// and build, which is exactly how it reached production once.
	const list: Agent[] = [
		agent('boss', { orchestrator: true, children: ['chief-a', 'chief-b'] }),
		agent('chief-a', { orchestrator: true, children: ['seeker'] }),
		agent('chief-b', { orchestrator: true, children: ['seeker'] }),
		agent('seeker')
	];
	const keys = teamTree(list, 'boss').map((n) => n.key);
	assert.equal(new Set(keys).size, keys.length, `clés dupliquées : ${keys.join(', ')}`);
	assert.ok(keys.includes('boss/chief-a/seeker'));
	assert.ok(keys.includes('boss/chief-b/seeker'));
});

test('the same child listed twice is walked once', () => {
	const list: Agent[] = [
		agent('boss', { orchestrator: true, children: ['seeker', 'seeker'] }),
		agent('seeker')
	];
	const nodes = teamTree(list, 'boss');
	assert.equal(nodes.filter((n) => n.agent.id === 'seeker').length, 1);
});
