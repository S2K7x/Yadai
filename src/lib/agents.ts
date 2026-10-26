/**
 * Custom agents — "ton équipe".
 *
 * An agent is a persona: a name, a job, and a system prompt. A conversation
 * belongs to one agent, and that agent's prompt is re-sent on EVERY turn.
 *
 * Why every turn, and why from the server: the `system_prompt` recorded when a
 * session is created is never read back by `_handle_session_chat_stream` — the
 * prompt for a turn comes only from `body.system_message` / `body.instructions`
 * (api_server.py 0.20.0, ~line 3782). The stored column only feeds
 * `has_system_prompt` and fork propagation, and `POST /api/sessions/{id}/model`
 * even sets it back to NULL. So the persona lives here and is re-composed by
 * the stream route on every message; the browser never gets to decide.
 *
 * Hierarchy is Hermes' own: the `delegate_task` tool (toolset `delegation`,
 * see tools/delegate_tool.py) spawns child agents, and `role: "orchestrator"`
 * keeps the delegation toolset on the child so it can spawn in turn. We do not
 * implement sub-agents — we only compose the prompt that tells an agent which
 * teammates it has and how to call them.
 *
 * Everything in this file is pure. The store owns the network, the routes
 * reuse `normalizeAgents()` so nothing unbounded reaches SQLite.
 */

import { clip, oneLine, slugify } from './text.ts';

export interface Agent {
	id: string;
	name: string;
	/** One or two characters shown in the sidebar and the thread header. */
	emoji: string;
	/** A key of `AGENT_COLORS`, or '' for the default accent. */
	color: string;
	/** The job, in one line: "Recherche web et synthèse". */
	role: string;
	/** The persona itself — what gets sent as `system_message`. */
	prompt: string;
	/** Preferred model, '' to use the gateway default. */
	model: string;
	/** May this agent pilot the ones in `children` via `delegate_task`? */
	orchestrator: boolean;
	/** Ids of the agents it is allowed to pilot. */
	children: string[];
	created_at: number;
	updated_at: number;
}

/** Bounds. A composed prompt is re-sent on every turn — it has to stay small. */
export const MAX_AGENTS = 24;
export const MAX_AGENT_NAME = 40;
export const MAX_AGENT_ROLE = 80;
export const MAX_AGENT_PROMPT = 6000;
export const MAX_AGENT_CHILDREN = 6;
/** How much of a teammate's own prompt is quoted in the leader's briefing. */
export const CHILD_BRIEF_CHARS = 800;
/** How deep the team tree is walked, for display and for the prompt. */
export const MAX_TEAM_DEPTH = 3;

/** Palette keys. The panel maps them to CSS colours; SQLite stores the key. */
export const AGENT_COLORS = ['ambre', 'vert', 'azur', 'indigo', 'prune', 'rose'] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const AGENT_COLOR_HEX: Record<string, string> = {
	ambre: '#d99a3c',
	vert: '#4fa373',
	azur: '#4a92c7',
	indigo: '#7b7ad4',
	prune: '#a86bb5',
	rose: '#cf6f8a'
};

/** What a swatch is called on screen. The keys above are stored, never shown. */
export const AGENT_COLOR_NAMES: Record<string, string> = {
	ambre: 'Amber',
	vert: 'Green',
	azur: 'Azure',
	indigo: 'Indigo',
	prune: 'Plum',
	rose: 'Pink'
};

/** The colour to paint an agent with — always a real colour. */
export const agentColor = (agent: Pick<Agent, 'color'>): string =>
	AGENT_COLOR_HEX[agent.color] ?? AGENT_COLOR_HEX.azur;

/**
 * Keep only the first couple of characters of an emoji field.
 *
 * Sliced by code point, not by UTF-16 unit, so a single emoji never comes back
 * as half a surrogate pair. Two code points is enough for one emoji plus a
 * variation selector; anything longer is a label, not a badge.
 */
export function normalizeEmoji(value: unknown): string {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	if (!trimmed) return '';
	return [...trimmed].slice(0, 3).join('');
}

/** A readable, stable id derived from a name. Collisions are the caller's job. */
export function agentSlug(name: string, suffix: string): string {
	const base = slugify(name, 32);
	return base ? `${base}-${suffix}` : `agent-${suffix}`;
}

/**
 * Coerce anything — a row written by an older version, a body posted by a
 * buggy client — into a bounded list of agents. Never throws.
 *
 * Two repairs matter beyond clipping: child ids that point nowhere are dropped
 * (an agent deleted while it was still on someone's team), and the result is
 * de-cycled, so no consumer can loop even if the database was edited by hand.
 */
export function normalizeAgents(value: unknown): Agent[] {
	if (!Array.isArray(value)) return [];
	const out: Agent[] = [];
	const seen = new Set<string>();

	for (const entry of value) {
		if (out.length >= MAX_AGENTS) break;
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;

		const id = typeof row.id === 'string' ? row.id.trim().slice(0, 64) : '';
		if (!id || seen.has(id)) continue;
		const name = typeof row.name === 'string' ? clip(oneLine(row.name), MAX_AGENT_NAME) : '';
		if (!name) continue;
		seen.add(id);

		const created = Number(row.created_at);
		const updated = Number(row.updated_at);
		out.push({
			id,
			name,
			emoji: normalizeEmoji(row.emoji),
			color: AGENT_COLORS.includes(row.color as AgentColor) ? (row.color as string) : '',
			role: typeof row.role === 'string' ? clip(oneLine(row.role), MAX_AGENT_ROLE) : '',
			prompt: typeof row.prompt === 'string' ? row.prompt.trim().slice(0, MAX_AGENT_PROMPT) : '',
			model: typeof row.model === 'string' ? row.model.trim().slice(0, 120) : '',
			orchestrator: row.orchestrator === true || row.orchestrator === 1,
			children: Array.isArray(row.children)
				? [
						...new Set(
							row.children.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
						)
					].slice(0, MAX_AGENT_CHILDREN)
				: [],
			created_at: Number.isFinite(created) && created > 0 ? created : 0,
			updated_at: Number.isFinite(updated) && updated > 0 ? updated : 0
		});
	}

	// Prune dangling references, then any edge that would close a loop.
	const ids = new Set(out.map((a) => a.id));
	for (const agent of out) agent.children = agent.children.filter((c) => c !== agent.id && ids.has(c));
	return breakCycles(out);
}

/**
 * Drop the edges that make the team graph loop.
 *
 * A cycle here would be a prompt that recurses forever, so this is a repair,
 * not a diagnostic: `validateAgent()` is what refuses a cycle at the door with
 * an explanation. Edges are removed in list order, so the first agent to
 * mention a teammate keeps it.
 */
function breakCycles(list: Agent[]): Agent[] {
	const byId = new Map(list.map((a) => [a.id, a]));
	const done = new Set<string>();
	const path = new Set<string>();

	const walk = (id: string) => {
		const agent = byId.get(id);
		if (!agent || done.has(id)) return;
		path.add(id);
		agent.children = agent.children.filter((child) => !path.has(child));
		for (const child of agent.children) walk(child);
		path.delete(id);
		done.add(id);
	};

	for (const agent of list) walk(agent.id);
	return list;
}

/**
 * Follow `children` from `startId` and return the looping path, if any.
 *
 * Used before saving: the answer is the chain to show the user
 * ("Chef → Recherche → Chef"), not just a boolean.
 */
export function teamCycle(list: Agent[], startId: string): string[] | null {
	const byId = new Map(list.map((a) => [a.id, a]));
	const path: string[] = [];
	const inPath = new Set<string>();
	const cleared = new Set<string>();

	const walk = (id: string): string[] | null => {
		if (inPath.has(id)) return [...path.slice(path.indexOf(id)), id];
		if (cleared.has(id)) return null;
		const agent = byId.get(id);
		if (!agent) return null;
		path.push(id);
		inPath.add(id);
		for (const child of agent.children) {
			const found = walk(child);
			if (found) return found;
		}
		path.pop();
		inPath.delete(id);
		cleared.add(id);
		return null;
	};

	return walk(startId);
}

export interface TeamNode {
	agent: Agent;
	depth: number;
	/** True when this node was reached again on the same branch — not expanded. */
	repeated: boolean;
	/**
	 * Unique per position in the tree: the chain of ids from the root.
	 *
	 * `id + depth` is NOT unique — two orchestrators at the same depth may
	 * pilot the same specialist, which is a perfectly normal team — and a
	 * repeated `{#each}` key throws at render time.
	 */
	key: string;
}

/**
 * The team under `rootId`, flattened depth-first with a depth marker.
 *
 * Only orchestrators expand: a leaf's `children` are ignored, because a leaf
 * child of `delegate_task` has the delegation toolset stripped and physically
 * cannot pilot anyone (DELEGATE_BLOCKED_TOOLS in tools/delegate_tool.py).
 */
export function teamTree(list: Agent[], rootId: string, maxDepth = MAX_TEAM_DEPTH): TeamNode[] {
	const byId = new Map(list.map((a) => [a.id, a]));
	const out: TeamNode[] = [];

	const walk = (id: string, depth: number, branch: Set<string>, path: string) => {
		const agent = byId.get(id);
		if (!agent) return;
		const key = path ? `${path}/${id}` : id;
		if (branch.has(id)) {
			out.push({ agent, depth, repeated: true, key });
			return;
		}
		out.push({ agent, depth, repeated: false, key });
		if (depth >= maxDepth || !agent.orchestrator) return;
		const next = new Set(branch).add(id);
		// Deduplicated: the same id listed twice among the children means the
		// same agent, and would produce two nodes sharing a path.
		for (const child of new Set(agent.children)) walk(child, depth + 1, next, key);
	};

	walk(rootId, 0, new Set(), '');
	return out;
}

/** The teammates an agent actually pilots: only if it orchestrates, and only known ids. */
export function directReports(list: Agent[], agent: Agent): Agent[] {
	if (!agent.orchestrator) return [];
	const byId = new Map(list.map((a) => [a.id, a]));
	return agent.children.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a));
}

/**
 * "🔎 Recherche" — the agent as one short label, **for the composed prompt**.
 *
 * Deliberately still carries the emoji, and deliberately NOT what the
 * interface shows any more. The UI moved to drawn marks (a coloured disc with
 * the agent's initial, see `agentInitial`), but this string is copied verbatim
 * into every system prompt and into the prompt of every scheduled task — and
 * a task's prompt is compared against a fresh composition to decide whether
 * its persona has gone stale (point 14). Changing this would mark every
 * agent-bearing task as needing an update, for a character no model reads
 * differently. Leave it alone.
 */
export const agentLabel = (agent: Pick<Agent, 'emoji' | 'name'>): string =>
	agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name;

/** The letter a coloured disc shows for an agent, where an emoji used to be. */
export const agentInitial = (agent: Pick<Agent, 'name'>): string =>
	agent.name.trim().charAt(0).toUpperCase() || '·';

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

/**
 * The briefing an orchestrator is told to copy into `delegate_task`'s
 * `context`. A delegated child starts from a blank conversation — its persona
 * can only come from the text of the call.
 */
function teammateBrief(agent: Agent): string {
	const lines = [`### ${agentLabel(agent)}${agent.role ? ` — ${agent.role}` : ''}`];
	if (agent.prompt) lines.push(clip(agent.prompt, CHILD_BRIEF_CHARS));
	return lines.join('\n');
}

/**
 * Build the `system_message` for one agent, teammates included.
 *
 * The delegation section is written from the child agents' own cards, which is
 * what makes a team "easy to customise": editing a specialist's job changes
 * what its leader is told about it, with nothing to rewrite by hand.
 *
 * Numbers Hermes enforces (`max_concurrent_children`, `max_spawn_depth`) are
 * deliberately NOT quoted: they live in `~/.hermes/config.yaml`, no endpoint
 * publishes them, and a stale figure in a system prompt is worse than none.
 */
export function composeSystemPrompt(list: Agent[], agentId: string): string {
	const agent = list.find((a) => a.id === agentId);
	if (!agent) return '';

	// The job goes on its own line rather than into the first sentence: a role
	// is written as a noun phrase ("Web research") as often as a verb phrase
	// ("Splits the work"), and only one of the two reads as an apposition.
	// Quoting it verbatim also keeps proper nouns intact — folding the case
	// would turn "on the Pi" into "on the pi".
	const blocks = [`You are ${agent.name}.${agent.role ? `\nYour role: ${agent.role}` : ''}`];
	if (agent.prompt) blocks.push(agent.prompt);

	const reports = directReports(list, agent);
	if (reports.length === 0) return blocks.join('\n\n');

	const byId = new Map(list.map((a) => [a.id, a]));
	const cards = reports.map((child) => {
		const brief = teammateBrief(child);
		const own = child.orchestrator
			? child.children.map((id) => byId.get(id)).filter((a): a is Agent => Boolean(a))
			: [];
		if (own.length === 0) return brief;
		return `${brief}\n\nLeads their own team: ${own.map((a) => a.name).join(', ')}. Call them with \`role: "orchestrator"\`.`;
	});

	blocks.push(
		'## Your team',
		'You lead the specialists below. When a task clearly belongs to one of them, hand it over with the `delegate_task` tool instead of doing it yourself; otherwise, answer directly.',
		...cards,
		'## How to delegate',
		[
			'`delegate_task` starts real Yadai sub-agents. They begin from an empty conversation and see NOTHING of this one: everything they need must fit in the call.',
			'',
			'- `tasks`: the list of sub-tasks, run in parallel, each `{goal, context, role}`. Yadai refuses a call that exceeds its limit of simultaneous sub-agents — if so, reduce the number or make several calls.',
			'- `goal`: the specialist\'s complete instruction, written as if you were writing to them.',
			'- `context`: first copy their card above — that is what gives them their role — then add the concrete details (files, constraints, expected format).',
			'- `role`: `"leaf"` for a specialist who does the work themselves, `"orchestrator"` only for those marked "leads their own team".',
			'- `output_schema` (optional): a JSON Schema the child\'s answer must validate against.',
			'',
			'Then it is up to you to read the results, cross-check them and write the final answer: the user does not see the sub-agents\' work, only yours.',
			'',
			'Cost: each sub-agent is a full Yadai agent on a four-core Raspberry Pi 5, shared with this conversation. Delegate when the task is truly separable, and prefer two well-posed sub-tasks to five vague ones.'
		].join('\n')
	);

	return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface AgentDraft {
	name: string;
	emoji: string;
	color: string;
	role: string;
	prompt: string;
	model: string;
	orchestrator: boolean;
	children: string[];
}

/**
 * Everything wrong with a draft, in French, ready to show.
 *
 * `id` is null when creating. `list` is the roster as it stands, so the cycle
 * check runs against what the save would actually produce.
 */
export function validateAgent(list: Agent[], id: string | null, draft: AgentDraft): string[] {
	const errors: string[] = [];
	const name = oneLine(draft.name);

	if (!name) errors.push('Give this agent a name.');
	else if (name.length > MAX_AGENT_NAME) errors.push(`The name exceeds ${MAX_AGENT_NAME} characters.`);
	if (list.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase()))
		errors.push('An agent already has this name.');

	if (!draft.prompt.trim()) errors.push('The system prompt is empty: without it, the agent has no personality.');
	else if (draft.prompt.length > MAX_AGENT_PROMPT)
		errors.push(`The prompt exceeds ${MAX_AGENT_PROMPT} characters.`);
	if (draft.role.length > MAX_AGENT_ROLE) errors.push(`The role exceeds ${MAX_AGENT_ROLE} characters.`);

	if (id === null && list.length >= MAX_AGENTS)
		errors.push(`You have reached ${MAX_AGENTS} agents — delete one first.`);

	const children = [...new Set(draft.children)];
	if (children.length > MAX_AGENT_CHILDREN)
		errors.push(`A team is limited to ${MAX_AGENT_CHILDREN} agents.`);
	if (id !== null && children.includes(id)) errors.push('An agent cannot lead itself.');
	if (children.some((c) => !list.some((a) => a.id === c)))
		errors.push('The team points to an agent that no longer exists.');

	// Run the check on the roster the save would produce, so an edit deep in
	// the tree is caught too — not just a direct A → B → A.
	if (draft.orchestrator && children.length > 0) {
		const nextId = id ?? '__draft__';
		const candidate: Agent[] = [
			...list.filter((a) => a.id !== id),
			{
				id: nextId,
				name,
				emoji: draft.emoji,
				color: draft.color,
				role: draft.role,
				prompt: draft.prompt,
				model: draft.model,
				orchestrator: true,
				children,
				created_at: 0,
				updated_at: 0
			}
		];
		const cycle = teamCycle(candidate, nextId);
		if (cycle) {
			const label = (cid: string) =>
				cid === nextId ? name || 'this agent' : (candidate.find((a) => a.id === cid)?.name ?? cid);
			errors.push(`Loop in the team: ${cycle.map(label).join(' → ')}.`);
		}
	}

	return errors;
}

/** Pull an agent draft out of an arbitrary request body, trusting none of it. */
export function draftFromBody(body: Record<string, unknown>): AgentDraft {
	return {
		name: typeof body.name === 'string' ? body.name : '',
		emoji: typeof body.emoji === 'string' ? body.emoji : '',
		color: typeof body.color === 'string' ? body.color : '',
		role: typeof body.role === 'string' ? body.role : '',
		prompt: typeof body.prompt === 'string' ? body.prompt : '',
		model: typeof body.model === 'string' ? body.model : '',
		orchestrator: body.orchestrator === true,
		children: Array.isArray(body.children)
			? body.children.filter((c): c is string => typeof c === 'string')
			: []
	};
}

/**
 * Turn a validated draft into a storable agent.
 *
 * It round-trips through `normalizeAgents` on purpose: one function decides
 * the bounds, and it is the same one that repairs rows on the way back out.
 * Returns null only if the draft has no usable name — `validateAgent` catches
 * that first.
 */
export function agentFromDraft(
	draft: AgentDraft,
	id: string,
	createdAt: number,
	now = Date.now() / 1000
): Agent | null {
	const [agent] = normalizeAgents([
		{ ...draft, id, created_at: createdAt || now, updated_at: now }
	]);
	return agent ?? null;
}

/** A draft with the same job as `source`, named "… (copie)". */
export function duplicateDraft(source: Agent): AgentDraft {
	return {
		name: clip(`${source.name} (copy)`, MAX_AGENT_NAME),
		emoji: source.emoji,
		color: source.color,
		role: source.role,
		prompt: source.prompt,
		model: source.model,
		orchestrator: source.orchestrator,
		children: [...source.children]
	};
}

export const emptyDraft = (): AgentDraft => ({
	name: '',
	emoji: '',
	color: AGENT_COLORS[0],
	role: '',
	prompt: '',
	model: '',
	orchestrator: false,
	children: []
});

// ---------------------------------------------------------------------------
// The starter team
// ---------------------------------------------------------------------------

/**
 * Four agents seeded on first use.
 *
 * A generalist, a team lead that pilots the other two, and two specialists —
 * enough to see what an orchestrator is without reading anything. Ids are
 * fixed so the seed is idempotent; the user can rename, edit or delete them.
 */
export function starterAgents(now: number): Agent[] {
	const make = (a: Omit<Agent, 'created_at' | 'updated_at'>): Agent => ({
		...a,
		created_at: now,
		updated_at: now
	});
	return [
		make({
			id: 'generaliste',
			name: 'Generalist',
			emoji: '🧭',
			color: 'azur',
			role: 'All-round assistant',
			prompt:
				"You are the user's personal assistant, running on their Raspberry Pi. You answer in English, directly and concretely.\n\nYou have a terminal, a browser, long-term memory and Yadai's skills. Use them rather than guessing: check before you claim, and say so when you could not check.\n\nGet to the point. No preamble, no restating the question. When a command is destructive, show it before running it.",
			model: '',
			orchestrator: false,
			children: []
		}),
		make({
			id: 'chef-equipe',
			name: 'Team lead',
			emoji: '🎯',
			color: 'ambre',
			role: 'Splits the work and hands it to the specialists',
			prompt:
				"You coordinate a small team. Your job is to understand the request, split it up, and bring the results together into one clear answer.\n\nStart by restating the goal in one sentence. If the request takes two minutes, do it yourself. Otherwise, split it into independent sub-tasks and give each one to the right specialist.\n\nAt the end, answer yourself: a summary in English, with what is certain, what is not, and what remains to be done.",
			model: '',
			orchestrator: true,
			children: ['chercheur', 'technicien']
		}),
		make({
			id: 'chercheur',
			name: 'Researcher',
			emoji: '🔎',
			color: 'vert',
			role: 'Web research and sourced summaries',
			prompt:
				"You search and you summarise. Use the browser and web search, cross-check at least two sources when the information matters, and cite your links.\n\nAlways return: the established facts, the uncertain points, and the sources. No opinion presented as fact. If you cannot find it, say so instead of filling the gap.",
			model: '',
			orchestrator: false,
			children: []
		}),
		make({
			id: 'technicien',
			name: 'Technician',
			emoji: '🛠️',
			color: 'indigo',
			role: 'System diagnostics, scripts and code on the Pi',
			prompt:
				"You are the household's systems engineer. You read code, inspect containers, systemd services and logs, and write short scripts.\n\nMeasure before concluding: a command that proves beats a hypothesis. Show the command and its useful output.\n\nChange nothing irreversible without announcing it first. When in doubt about a deletion or a restart, propose the command instead of running it.",
			model: '',
			orchestrator: false,
			children: []
		})
	];
}
