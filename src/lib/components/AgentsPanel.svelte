<script lang="ts">
	import Modal from './Modal.svelte';
	import { agents } from '$lib/stores/agents.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import {
		AGENT_COLORS,
		AGENT_COLOR_HEX,
		MAX_AGENT_CHILDREN,
		MAX_AGENT_NAME,
		MAX_AGENT_PROMPT,
		MAX_AGENT_ROLE,
		agentColor,
		agentInitial,
		composeSystemPrompt,
		duplicateDraft,
		emptyDraft,
		teamTree,
		validateAgent,
		type Agent,
		type AgentDraft
	} from '$lib/agents';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	/** null = the list; a string id = editing that agent; '' = creating one. */
	let editing = $state<string | null>(null);
	let draft = $state<AgentDraft>(emptyDraft());

	$effect(() => {
		if (open) agents.ensureLoaded();
	});

	/**
	 * The roster as it would be after saving, so the tree and the prompt
	 * preview show what the user is about to get rather than what is stored.
	 */
	let candidate = $derived.by<Agent[]>(() => {
		if (editing === null) return agents.items;
		const id = editing || '__draft__';
		const base = agents.items.find((a) => a.id === editing);
		const row: Agent = {
			id,
			name: draft.name.trim() || 'Nouvel agent',
			emoji: draft.emoji,
			color: draft.color,
			role: draft.role.trim(),
			prompt: draft.prompt,
			model: draft.model,
			orchestrator: draft.orchestrator,
			children: draft.children,
			created_at: base?.created_at ?? 0,
			updated_at: 0
		};
		return [...agents.items.filter((a) => a.id !== editing), row];
	});

	let draftId = $derived(editing || '__draft__');
	let errors = $derived(editing === null ? [] : validateAgent(agents.items, editing || null, draft));
	let tree = $derived(editing === null ? [] : teamTree(candidate, draftId));
	let preview = $derived(editing === null ? '' : composeSystemPrompt(candidate, draftId));
	/** Everyone but the agent being edited — you cannot put yourself on your own team. */
	let pickable = $derived(agents.items.filter((a) => a.id !== editing));
	// Deduplicated: the same model id can be offered by two providers
	// (claude-sonnet-5 arrives from both anthropic and openrouter), and a
	// repeated key throws `each_key_duplicate` at render time — which type
	// checking, tests and the build all miss.
	let models = $derived([
		...new Set(chat.models?.providers?.flatMap((p) => p.models ?? []) ?? [])
	]);

	function startCreate() {
		draft = emptyDraft();
		editing = '';
	}

	function startEdit(agent: Agent) {
		draft = {
			name: agent.name,
			emoji: agent.emoji,
			color: agent.color || AGENT_COLORS[0],
			role: agent.role,
			prompt: agent.prompt,
			model: agent.model,
			orchestrator: agent.orchestrator,
			children: [...agent.children]
		};
		editing = agent.id;
	}

	function startDuplicate(agent: Agent) {
		draft = duplicateDraft(agent);
		editing = '';
	}

	function toggleChild(id: string) {
		draft.children = draft.children.includes(id)
			? draft.children.filter((c) => c !== id)
			: [...draft.children, id];
	}

	async function submit() {
		if (errors.length > 0 || agents.saving) return;
		const saved = editing ? await agents.update(editing, draft) : await agents.create(draft);
		if (!saved) return;
		editing = null;
		// A renamed or re-scoped agent changes what the sidebar shows.
		chat.refreshSessions();
	}

	async function confirmRemove(agent: Agent) {
		const used = chat.sessions.filter((s) => s.agent_id === agent.id).length;
		const warning = used
			? `\n\n${used} conversation${used > 1 ? 's' : ''} repasseront au prompt par défaut de Yadai (leur historique est conservé).`
			: '';
		if (!confirm(`Supprimer l'agent « ${agent.name} » ?${warning}`)) return;
		if (await agents.remove(agent.id)) {
			if (editing === agent.id) editing = null;
			chat.refreshSessions();
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			if (editing !== null) editing = null;
			else onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Modal
	{open}
	title={editing === null ? 'Ton équipe' : editing ? "Modifier l'agent" : 'Nouvel agent'}
	label="Équipe d'agents"
	width={660}
	{onclose}
>
	{#snippet subtitle()}Chaque agent a son métier et son prompt{/snippet}

	<div class="body">
		{#if editing === null}
			{#if agents.loadError}
				<!-- Above the list, not instead of it, and above the create button:
				     creating is still safe (the server validates against its own
				     roster and answers with the real one), but "Aucun agent" said
				     over a read that never landed is the claim worth not making. -->
				<div class="read-failed">
					<p>La liste des agents n'a pas pu être lue.</p>
					<p class="why">{agents.loadError}</p>
					<button onclick={() => void agents.reload()} disabled={agents.loading}>
						{agents.loading ? 'Lecture…' : 'Réessayer'}
					</button>
				</div>
			{/if}

			<button class="new" onclick={startCreate}>＋ Nouvel agent</button>

			{#if !agents.loaded && agents.loading}
				<p class="none">Chargement…</p>
			{:else if agents.loaded && agents.items.length === 0}
				<p class="none">
					Aucun agent pour l'instant. Un agent, c'est un nom, un métier et un prompt système
					renvoyé à chaque message.
				</p>
			{/if}

			<ul class="list">
				{#each agents.items as agent (agent.id)}
					{@const team = teamTree(agents.items, agent.id).slice(1)}
					<li style="--agent: {agentColor(agent)}">
						<div class="row">
							<span class="badge">{agentInitial(agent)}</span>
							<span class="who">
								<span class="name">{agent.name}</span>
								{#if agent.role}<span class="job">{agent.role}</span>{/if}
							</span>
							{#if agent.orchestrator && team.length > 0}
								<span class="tag" title="Cet agent peut déléguer à d'autres">chef d'équipe</span>
							{/if}
						</div>
						{#if agent.orchestrator && team.length > 0}
							<ul class="tree">
								{#each team as node (node.key)}
									<li style="padding-left: {(node.depth - 1) * 16}px">
										<span class="branch">└</span>
										{node.agent.name}
										{#if node.agent.role}<span class="job">— {node.agent.role}</span>{/if}
										{#if node.repeated}<span class="job">(déjà plus haut)</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
						<div class="ops">
							<button onclick={() => startEdit(agent)}>Modifier</button>
							<button onclick={() => startDuplicate(agent)}>Dupliquer</button>
							<button class="danger" onclick={() => confirmRemove(agent)}>Supprimer</button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="form">
				<!-- The emoji field is gone from the form: an agent is shown as a
				     coloured disc bearing its initial now, so the value would be
				     stored and never drawn. The column is deliberately still
				     written on save (`emoji: draft.emoji` below keeps whatever a
				     previous version put there) — dropping a field is one thing,
				     erasing what someone typed into it is another, and the same
				     string is still copied into the composed prompt. -->
				<label>
					Nom
					<input bind:value={draft.name} placeholder="Chercheur" maxlength={MAX_AGENT_NAME} />
				</label>

				<div class="swatches" role="group" aria-label="Couleur">
					{#each AGENT_COLORS as color (color)}
						<button
							type="button"
							class:sel={draft.color === color}
							style="--agent: {AGENT_COLOR_HEX[color]}"
							aria-label={color}
							title={color}
							onclick={() => (draft.color = color)}></button>
					{/each}
				</div>

				<label>
					Métier
					<input
						bind:value={draft.role}
						placeholder="Recherche en ligne et synthèse sourcée"
						maxlength={MAX_AGENT_ROLE}
					/>
				</label>
				<p class="muted small">Une ligne. C'est ce que lit un chef d'équipe pour savoir quand le solliciter.</p>

				<label>
					Prompt système
					<textarea
						bind:value={draft.prompt}
						rows="8"
						maxlength={MAX_AGENT_PROMPT}
						placeholder="Tu cherches et tu synthétises. Croise au moins deux sources et cite tes liens…"
					></textarea>
				</label>
				<p class="muted small">
					Renvoyé à Yadai à chaque message de la conversation — {draft.prompt.length} / {MAX_AGENT_PROMPT}
					caractères.
				</p>

				{#if models.length > 0}
					<label>
						Modèle préféré
						<select bind:value={draft.model}>
							<option value="">Modèle par défaut de Yadai</option>
							{#each models as model (model)}
								<option value={model}>{model}</option>
							{/each}
						</select>
					</label>
					<p class="muted small">
						Appliqué aux conversations démarrées avec cet agent. Un modèle que la passerelle ne
						sait plus router est ignoré au profit du défaut.
					</p>
				{/if}

				<label class="check">
					<input type="checkbox" bind:checked={draft.orchestrator} />
					<span>Peut piloter d'autres agents</span>
				</label>
				<p class="muted small">
					Coché, son prompt reçoit la fiche des agents ci-dessous et la marche à suivre pour les
					lancer avec l'outil <code>delegate_task</code> de Yadai. Chaque agent lancé est un agent
					Yadai complet qui tourne sur le même Raspberry&nbsp;Pi&nbsp;5 : à quatre cœurs, deux ou
					trois en parallèle se sentent passer. Un agent piloté ne voit rien de la conversation —
					le chef doit tout lui écrire.
				</p>

				{#if draft.orchestrator}
					{#if pickable.length === 0}
						<p class="muted small">Créez d'abord un autre agent à piloter.</p>
					{:else}
						<div class="picks">
							{#each pickable as agent (agent.id)}
								<label class="pick" class:on={draft.children.includes(agent.id)}>
									<input
										type="checkbox"
										checked={draft.children.includes(agent.id)}
										disabled={!draft.children.includes(agent.id) &&
											draft.children.length >= MAX_AGENT_CHILDREN}
										onchange={() => toggleChild(agent.id)}
									/>
									<span>{agent.name}</span>
									{#if agent.orchestrator}<span class="job">chef</span>{/if}
								</label>
							{/each}
						</div>
					{/if}

					{#if tree.length > 1}
						<div class="preview-tree">
							<span class="muted small">L'équipe telle que Yadai la verra :</span>
							<ul class="tree">
								{#each tree as node (node.key)}
									<li style="padding-left: {node.depth * 16}px">
										{#if node.depth > 0}<span class="branch">└</span>{/if}
										{node.agent.name}
										{#if node.repeated}<span class="job">(déjà plus haut)</span>{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}

				{#if errors.length > 0}
					<ul class="errs">
						{#each errors as error (error)}
							<li>{error}</li>
						{/each}
					</ul>
				{/if}

				{#if preview}
					<details>
						<summary>Voir le prompt envoyé à chaque message</summary>
						<pre>{preview}</pre>
					</details>
				{/if}

				<div class="actions">
					<button onclick={() => (editing = null)}>Annuler</button>
					<button class="primary" disabled={errors.length > 0 || agents.saving} onclick={submit}>
						{agents.saving ? 'Enregistrement…' : 'Enregistrer'}
					</button>
				</div>
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<span class="foot-note">
			Une conversation appartient à un agent ; changer d'agent s'applique au message suivant.
		</span>
	{/snippet}
</Modal>

<style>
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 16px;
	}
	.new {
		width: 100%;
		padding: 9px 12px;
		border: 1px dashed var(--border);
		border-radius: 9px;
		font-size: 13.5px;
		color: var(--text-muted);
	}
	.new:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.list {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.list > li {
		padding: 10px 12px;
		border: 1px solid var(--border-soft);
		border-left: 3px solid var(--agent);
		border-radius: 10px;
		background: var(--bg-sunken);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.badge {
		flex: 0 0 auto;
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: color-mix(in srgb, var(--agent) 22%, transparent);
		font-size: 14px;
	}
	.who {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.name {
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.job {
		font-size: 11.5px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		flex: 0 0 auto;
		padding: 2px 8px;
		border-radius: 20px;
		background: color-mix(in srgb, var(--agent) 18%, transparent);
		color: var(--text-muted);
		font-size: 11px;
	}
	.tree {
		list-style: none;
		margin: 7px 0 0;
		padding: 0;
		font-size: 12px;
		color: var(--text-muted);
	}
	.tree li {
		padding: 1px 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.branch {
		color: var(--text-faint);
		margin-right: 4px;
	}
	.ops {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 9px;
	}
	.ops button,
	.actions button {
		padding: 5px 11px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 12.5px;
	}
	.ops button:hover:not(:disabled),
	.actions button:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.danger:not(:disabled) {
		color: var(--danger);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button.primary:not(:disabled) {
		background: var(--bg-sunken);
		font-weight: 600;
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.form label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.form input,
	.form textarea,
	.form select {
		padding: 7px 10px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13.5px;
		font-family: inherit;
		color: var(--text);
	}
	.form textarea {
		resize: vertical;
		line-height: 1.5;
	}
	.form input:focus,
	.form textarea:focus,
	.form select:focus {
		border-color: var(--border);
	}
	.form label.check {
		flex-direction: row;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		color: var(--text);
	}
	.form label.check input {
		width: auto;
		padding: 0;
	}
	.swatches {
		display: flex;
		gap: 7px;
		margin-top: -4px;
	}
	.swatches button {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--agent);
		border: 2px solid transparent;
		outline-offset: 2px;
	}
	.swatches button.sel {
		border-color: var(--text);
	}
	.picks {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.pick {
		flex-direction: row !important;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: 1px solid var(--border-soft);
		border-radius: 20px;
		font-size: 12.5px;
	}
	.pick.on {
		border-color: var(--accent);
		color: var(--text);
	}
	.preview-tree {
		padding: 9px 11px;
		border: 1px solid var(--border-soft);
		border-radius: 9px;
		background: var(--bg-sunken);
	}
	.errs {
		list-style: none;
		margin: 0;
		padding: 8px 11px;
		border-radius: 9px;
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 12.5px;
	}
	.errs li + li {
		margin-top: 4px;
	}
	details {
		font-size: 12.5px;
		color: var(--text-muted);
	}
	summary {
		cursor: pointer;
	}
	pre {
		margin: 8px 0 0;
		padding: 10px;
		max-height: 260px;
		overflow: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 8px;
		font-size: 11.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	code {
		font-size: 11.5px;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 12px;
	}
	.form p.muted {
		margin: -4px 0 0;
	}
	.none {
		padding: 26px 10px;
		text-align: center;
		color: var(--text-faint);
		font-size: 13px;
	}
	.read-failed {
		margin-bottom: var(--gap-card);
		padding: 12px 14px;
		border-radius: var(--radius-card);
		background: var(--danger-soft);
		text-align: center;
	}
	.read-failed p {
		margin: 0 0 6px;
		font-size: 13px;
	}
	.read-failed .why {
		color: var(--text-muted);
		font-size: 12px;
	}
	.read-failed button {
		min-height: 44px;
		padding: 6px 16px;
		border-radius: 999px;
		background: var(--bg-raised);
		font-size: 13px;
	}
	.read-failed button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.foot-note {
		flex: 1;
		min-width: 0;
		color: var(--text-muted);
		font-size: 12px;
	}
</style>
