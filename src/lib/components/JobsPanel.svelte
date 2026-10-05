<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import { shouldLoadPanel } from '$lib/availability';
	import { jobsStore, type JobInput } from '$lib/stores/jobs.svelte';
	import { agents } from '$lib/stores/agents.svelte';
	import { agentColor, composeSystemPrompt } from '$lib/agents';
	import {
		JOB_TEMPLATES,
		MAX_JOB_NAME,
		SCHEDULE_MODES,
		WEEKDAYS,
		canEditJob,
		composeJobPrompt,
		defaultScheduleSpec,
		deliveryHint,
		jobInstructionLimit,
		jobState,
		lastRunLabel,
		nextRunLabel,
		parseSchedule,
		scheduleDisplay,
		scheduleExpression,
		scheduleFromSpec,
		specFromExpression,
		targetLabel,
		type ScheduleMode,
		type ScheduleSpec
	} from '$lib/jobs';
	import type { HermesJob } from '$lib/types';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	/** null = the list; a string = editing that job; '' = creating a new one. */
	let editing = $state<string | null>(null);
	let name = $state('');
	let instruction = $state('');
	let deliver = $state('local');
	let agentId = $state<string | null>(null);
	let spec = $state<ScheduleSpec>(defaultScheduleSpec());

	// Loaded on first open only — a Pi has better things to do than poll a job
	// list nobody is looking at. The roster comes along because a task now
	// carries an agent, and its card is composed here to show its cost. A
	// *failed* read is the one case worth retrying on a later opening, which is
	// what `shouldLoadPanel` adds over the old "jobs === null" guard.
	// The state reads are untracked so this fires once per opening and not once
	// per store mutation: `failed` is now a state that *asks* to reload, so an
	// effect that re-ran on it would retry in a tight loop against the very
	// thing that just failed. `open` is the only dependency.
	$effect(() => {
		if (!open) return;
		if (untrack(() => shouldLoadPanel(jobsStore.state, jobsStore.loading))) jobsStore.refresh();
		agents.ensureLoaded();
	});

	let schedule = $derived(scheduleFromSpec(spec));
	// Re-evaluated on every keystroke so the preview follows what is picked. The
	// clock is read here rather than inside parseSchedule's default so "dans
	// 30 min" stays honest while the form sits open.
	let parsed = $derived(parseSchedule(schedule, new Date()));

	// The very same composition the server will do, so the character budget
	// shown here is the real one and not an estimate.
	let persona = $derived(agentId ? composeSystemPrompt(agents.items, agentId) : '');
	let composed = $derived(composeJobPrompt(persona, instruction));
	let limit = $derived(jobInstructionLimit(Boolean(persona)));

	let canSubmit = $derived(
		!jobsStore.creating &&
			name.trim().length > 0 &&
			name.trim().length <= MAX_JOB_NAME &&
			instruction.trim().length > 0 &&
			instruction.trim().length <= limit &&
			parsed.kind !== null
	);

	function startCreate(from?: HermesJob) {
		editing = '';
		name = from ? `${from.name ?? ''} (copie)`.slice(0, MAX_JOB_NAME) : '';
		instruction = from ? (from.instruction ?? from.prompt ?? '') : '';
		agentId = from ? (from.agent_id ?? null) : null;
		deliver = from?.deliver ?? jobsStore.deliveryChoices[0]?.id ?? 'local';
		spec = from ? specFromExpression(scheduleExpression(from)) : defaultScheduleSpec();
	}

	function startEdit(job: HermesJob) {
		editing = job.id ?? '';
		name = job.name ?? '';
		// A task planned before this panel knew about agents has no recorded
		// instruction: its whole prompt IS the instruction, and it has no card.
		instruction = job.instruction ?? job.prompt ?? '';
		agentId = job.agent_id ?? null;
		deliver = job.deliver ?? 'local';
		spec = specFromExpression(scheduleExpression(job));
	}

	function applyTemplate(template: (typeof JOB_TEMPLATES)[number]) {
		name = template.name;
		instruction = template.instruction;
	}

	async function submit() {
		if (!canSubmit) return;
		const input: JobInput = {
			name: name.trim(),
			schedule: schedule.trim(),
			instruction: instruction.trim(),
			agentId,
			deliver
		};
		const ok = editing ? await jobsStore.update(editing, input) : await jobsStore.create(input);
		if (ok) editing = null;
	}

	/** State, next run, last run and destination as one string. */
	function metaLine(job: HermesJob): string {
		const state = jobState(job);
		const parts = [state.label];
		const next = nextRunLabel(job);
		if (next && state.key !== 'paused') parts.push(`prochaine ${next}`);
		const last = lastRunLabel(job);
		if (last) parts.push(last);
		if (job.deliver && job.deliver !== 'local') parts.push(`envoyé sur ${job.deliver}`);
		return parts.join(' · ');
	}

	function confirmRemove(id: string, label: string) {
		if (!confirm(`Supprimer définitivement la tâche « ${label} » ?`)) return;
		jobsStore.remove(id);
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			if (editing !== null) editing = null;
			else onclose();
		}
	}

	const modeLabel = (value: ScheduleMode) =>
		SCHEDULE_MODES.find((m) => m.value === value)?.label ?? '';
</script>

<svelte:window onkeydown={onKeydown} />

<Modal {open} title="Tâches planifiées" width={620} {onclose}>
	{#snippet subtitle()}Yadai les exécute seul, même app fermée{/snippet}

	<div class="body">
		{#if jobsStore.state === 'disabled'}
			<p class="none">
				Ce Yadai tourne sans son module cron : aucune tâche ne peut être planifiée.
			</p>
		{:else if editing !== null}
			<div class="form">
				{#if !editing}
					<div class="templates">
						<span class="muted small">Pour démarrer :</span>
						{#each JOB_TEMPLATES as template (template.label)}
							<button type="button" onclick={() => applyTemplate(template)}>
								{template.label}
							</button>
						{/each}
					</div>
				{/if}

				<label>
					Nom
					<input bind:value={name} placeholder="Résumé du matin" maxlength={MAX_JOB_NAME} />
				</label>

				<fieldset class="who">
					<legend>Qui s'en charge</legend>
					<div class="chips">
						<button
							type="button"
							class:sel={agentId === null}
							onclick={() => (agentId = null)}
							style="--agent: var(--text-faint)"
						>
							<span class="dot"></span>Yadai par défaut
						</button>
						{#each agents.items as agent (agent.id)}
							<button
								type="button"
								class:sel={agentId === agent.id}
								onclick={() => (agentId = agent.id)}
								style="--agent: {agentColor(agent)}"
							>
								<span class="dot"></span>{agent.name}
							</button>
						{/each}
					</div>
					{#if agents.loadError}
						<!-- Without this the chips just silently lack their agents, and
						     the character budget below is computed as if no card rode
						     along: the server, which composes from its own roster,
						     would then refuse the save on a limit never shown here. -->
						<div class="read-failed">
							<p>L'équipe n'a pas pu être lue — les agents manquent ci-dessus.</p>
							<p class="muted small">{agents.loadError}</p>
							<button type="button" onclick={() => void agents.reload()} disabled={agents.loading}>
								{agents.loading ? 'Lecture…' : 'Réessayer'}
							</button>
						</div>
					{/if}
					<p class="muted small">
						{#if agentId}
							La fiche de cet agent part avec la tâche : elle s'exécutera avec sa personnalité et
							son équipe.
						{:else}
							La tâche tournera avec le prompt système par défaut de Yadai.
						{/if}
					</p>
				</fieldset>

				<fieldset class="when">
					<legend>Quand</legend>
					<div class="chips modes">
						{#each SCHEDULE_MODES as m (m.value)}
							<button
								type="button"
								class:sel={spec.mode === m.value}
								onclick={() => (spec = { ...spec, mode: m.value })}>{m.label}</button
							>
						{/each}
					</div>

					<div class="fields">
						{#if spec.mode === 'daily'}
							<span class="lead">à</span>
							<input type="time" bind:value={spec.time} />
						{:else if spec.mode === 'weekly'}
							<span class="lead">chaque</span>
							<select bind:value={spec.weekday}>
								{#each WEEKDAYS as day (day.value)}
									<option value={day.value}>{day.label}</option>
								{/each}
							</select>
							<span class="lead">à</span>
							<input type="time" bind:value={spec.time} />
						{:else if spec.mode === 'monthly'}
							<span class="lead">le</span>
							<select bind:value={spec.monthday}>
								{#each Array.from({ length: 28 }, (_, i) => i + 1) as day (day)}
									<option value={day}>{day}</option>
								{/each}
							</select>
							<span class="lead">de chaque mois, à</span>
							<input type="time" bind:value={spec.time} />
						{:else if spec.mode === 'interval'}
							<span class="lead">toutes les</span>
							<input class="num" type="number" min="1" max="999" bind:value={spec.every} />
							<select bind:value={spec.unit}>
								<option value="m">minutes</option>
								<option value="h">heures</option>
								<option value="d">jours</option>
							</select>
						{:else if spec.mode === 'once'}
							<span class="lead">le</span>
							<input type="datetime-local" bind:value={spec.at} />
						{:else}
							<input
								class="grow"
								bind:value={spec.raw}
								placeholder="0 8 * * 1-5"
								autocapitalize="off"
								autocorrect="off"
								spellcheck="false"
							/>
						{/if}
					</div>

					{#if spec.mode === 'advanced'}
						<p class="muted small">
							Expression cron à cinq champs, « every 30m », « 2h » ou une date ISO. Utile pour ce
							que les choix ci-dessus ne couvrent pas (« 0 8 * * 1-5 » : en semaine seulement).
						</p>
					{/if}
					{#if spec.mode === 'monthly'}
						<p class="muted small">
							Le 29, le 30 et le 31 sauteraient des mois : la liste s'arrête au 28.
						</p>
					{/if}

					<p class="preview" class:bad={parsed.kind === null}>
						{parsed.kind === null ? parsed.error : `Tournera ${parsed.display}.`}
					</p>
				</fieldset>

				<label>
					Instruction pour Yadai
					<textarea
						bind:value={instruction}
						rows="5"
						maxlength={limit}
						placeholder="Résume les nouveautés tech du jour en cinq puces."
					></textarea>
				</label>
				<p class="muted small">
					L'instruction doit se suffire à elle-même : la tâche tourne dans sa propre conversation,
					sans le contexte de celle-ci.
					{#if agentId}
						<br />Prompt envoyé : {composed.prompt.length} caractères, dont {composed.personaChars}
						pour la fiche de l'agent.
					{/if}
				</p>
				{#if composed.clipped}
					<p class="preview bad">
						L'instruction est trop longue pour laisser passer la fiche de l'agent en entier :
						raccourcissez-la, ou choisissez « Yadai par défaut ».
					</p>
				{/if}

				{#if jobsStore.deliveryChoices.length > 1}
					<label>
						Livraison
						<select bind:value={deliver}>
							{#each jobsStore.deliveryChoices as target (target.id)}
								<option value={target.id}>{targetLabel(target)}</option>
							{/each}
						</select>
					</label>
				{/if}
				<p class="muted small">{deliveryHint(deliver)}</p>
			</div>
		{:else}
			<!-- Above the list, not instead of it: a refresh that fails after an
			     action must not make the tasks vanish from the screen. -->
			{#if jobsStore.state === 'failed'}
				<div class="read-failed">
					<p>La liste des tâches n'a pas pu être lue.</p>
					<p class="muted small">{jobsStore.loadError}</p>
					<button onclick={() => jobsStore.refresh(true)} disabled={jobsStore.loading}>
						{jobsStore.loading ? 'Lecture…' : 'Réessayer'}
					</button>
				</div>
			{/if}

			<button class="new" onclick={() => startCreate()}>＋ Nouvelle tâche</button>

			{#if jobsStore.jobs === null && jobsStore.loading}
				<p class="none">Chargement…</p>
			{:else if jobsStore.jobs !== null && jobsStore.sorted.length === 0}
				<p class="none">
					Aucune tâche planifiée. Un rappel dans deux heures ou un résumé chaque matin, confié à
					l'agent de votre choix, c'est ici.
				</p>
			{/if}

			<ul class="jobs">
				{#each jobsStore.sorted as job (job.id)}
					{@const state = jobState(job)}
					{@const agent = agents.byId(job.agent_id)}
					<li class:paused={state.key === 'paused'}>
						<div class="row">
							<span class="icon" data-state={state.key} title={state.label}>
								<Icon name={state.icon} size={15} />
							</span>
							<span class="title">{job.name}</span>
							<span class="when">{scheduleDisplay(job)}</span>
						</div>
						{#if agent}
							<span class="owner" style="--agent: {agentColor(agent)}">
								<span class="dot"></span>{agent.name}
							</span>
						{/if}
						{#if job.instruction || job.prompt}
							<p class="prompt">{job.instruction || job.prompt}</p>
						{/if}
						<div class="meta">
							<span class="muted small">{metaLine(job)}</span>
						</div>
						{#if job.persona_stale && canEditJob(job)}
							<p class="stale">
								La fiche de {agent ? agent.name : "l'agent"} a changé depuis.
								<button
									disabled={jobsStore.busyId === job.id}
									onclick={() => jobsStore.resync(job)}>Mettre à jour</button
								>
							</p>
						{/if}
						{#if job.last_error}
							<p class="err">{job.last_error}</p>
						{/if}
						<div class="ops">
							<button
								disabled={jobsStore.busyId === job.id}
								onclick={() => jobsStore.act(job.id!, 'run')}>Lancer</button
							>
							<button
								disabled={jobsStore.busyId === job.id}
								onclick={() => jobsStore.act(job.id!, state.key === 'paused' ? 'resume' : 'pause')}
							>
								{state.key === 'paused' ? 'Reprendre' : 'Mettre en pause'}
							</button>
							<button disabled={jobsStore.busyId === job.id} onclick={() => startEdit(job)}>
								Modifier
							</button>
							<button disabled={jobsStore.busyId === job.id} onclick={() => startCreate(job)}>
								Dupliquer
							</button>
							<button
								class="danger"
								disabled={jobsStore.busyId === job.id}
								onclick={() => confirmRemove(job.id!, job.name ?? job.id!)}>Supprimer</button
							>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#snippet footer()}
		<!-- The form's own actions live here, not at the end of the body: the
		     footer is the one part of the sheet that stays visible, and on a
		     phone the submit button was below a five-row textarea. -->
		<span class="foot-note">
			{#if jobsStore.state === 'disabled'}
				&nbsp;
			{:else if editing !== null}
				{modeLabel(spec.mode)} · {parsed.kind === null ? 'horaire à compléter' : parsed.display}
			{:else}
				Une tâche tourne côté Pi avec tous les outils de Yadai.
			{/if}
		</span>
		{#if editing !== null && jobsStore.state !== 'disabled'}
			<button class="refresh" onclick={() => (editing = null)}>Annuler</button>
			<button class="refresh primary" disabled={!canSubmit} onclick={submit}>
				{jobsStore.creating ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Planifier'}
			</button>
		{:else}
			<button class="refresh" onclick={() => jobsStore.refresh()} disabled={jobsStore.loading}>
				Actualiser
			</button>
		{/if}
	{/snippet}
</Modal>

<style>
	.foot-note {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: 12px;
	}
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
	.jobs {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.jobs li {
		padding: 10px 12px;
		border: 1px solid var(--border-soft);
		border-radius: 10px;
		background: var(--bg-sunken);
	}
	.jobs li.paused {
		opacity: 0.68;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	/* The mark is drawn now, so its colour is ours to choose. The states the
	   emoji used to colour out of its own font keep saying so — from the
	   palette this time, so they follow the sixteen presets. */
	.icon {
		flex: 0 0 auto;
		display: flex;
		color: var(--text-faint);
	}
	.icon[data-state='completed'] {
		color: var(--ok);
	}
	.icon[data-state='error'] {
		color: var(--danger);
	}
	.icon[data-state='running'] {
		color: var(--accent);
	}
	.title {
		flex: 1;
		min-width: 0;
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		flex: 0 0 auto;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.owner {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: 6px;
		padding: 2px 8px;
		border: 1px solid var(--border-soft);
		border-radius: 20px;
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--agent);
		flex: 0 0 auto;
	}
	.prompt {
		margin: 5px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.meta {
		margin-top: 5px;
	}
	.stale {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin: 7px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}
	.err {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.ops {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 9px;
	}
	.ops button,
	.stale button,
	.refresh {
		padding: 5px 11px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 12.5px;
	}
	.ops button:hover:not(:disabled),
	.stale button:hover:not(:disabled),
	.refresh:hover:not(:disabled) {
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
	fieldset {
		margin: 0;
		padding: 9px 11px;
		border: 1px solid var(--border-soft);
		border-radius: 9px;
	}
	legend {
		padding: 0 5px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chips button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: 1px solid var(--border-soft);
		border-radius: 20px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.chips button:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.chips button.sel {
		border-color: var(--agent, var(--accent));
		color: var(--text);
		background: var(--bg-hover);
	}
	.modes button.sel {
		border-color: var(--accent);
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 7px;
		margin-top: 9px;
	}
	.fields .lead {
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.fields .num {
		width: 76px;
	}
	.fields .grow {
		flex: 1;
		min-width: 180px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12.5px;
	}
	.templates {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.templates button {
		padding: 4px 10px;
		border: 1px solid var(--border-soft);
		border-radius: 20px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.templates button:hover {
		background: var(--bg-hover);
		color: var(--text);
	}
	.preview {
		margin: 9px 0 0;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.preview.bad {
		color: var(--danger);
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
	.form fieldset p.muted {
		margin: 8px 0 0;
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
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		text-align: center;
	}
	.read-failed p {
		margin: 0 0 6px;
		font-size: 13px;
	}
	.read-failed button {
		min-height: 34px;
		padding: 6px 14px;
		border-radius: 999px;
		background: var(--bg-sunken);
		font-size: 13px;
	}
	.read-failed button:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
