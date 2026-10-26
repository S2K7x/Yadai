<script lang="ts">
	import { untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import { shouldLoadPanel } from '$lib/availability';
	import { skillsStore } from '$lib/stores/skills.svelte';
	import { relativeTime } from '$lib/sessions';
	import { formatBytes } from '$lib/format';
	import {
		DESCRIPTION_FILE,
		MAX_SKILL_BYTES,
		groupSkillFiles,
		isValidSkillName,
		skillKey,
		slugifySkillName,
		utf8Length,
		type SkillRef
	} from '$lib/skills';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	let query = $state('');
	let creating = $state(false);
	let newCategory = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let submitting = $state(false);

	// Load once: the listing stats ~80 files, which is not something to repeat
	// on a Pi while the panel merely sits there. A *failed* read is the one
	// case worth retrying, so closing and reopening heals a blip — see
	// `shouldLoadPanel`.
	// The state reads are untracked so this fires once per opening and not once
	// per store mutation: `failed` is now a state that *asks* to reload, so an
	// effect that re-ran on it would retry in a tight loop against the very
	// thing that just failed. `open` is the only dependency.
	$effect(() => {
		if (!open) return;
		if (untrack(() => shouldLoadPanel(skillsStore.state, skillsStore.loading))) {
			skillsStore.refresh();
		}
	});

	let groups = $derived(groupSkillFiles(skillsStore.entries, query));
	let bytes = $derived(utf8Length(skillsStore.content));
	let overLimit = $derived(bytes > MAX_SKILL_BYTES);

	function isSelected(ref: SkillRef): boolean {
		return !!skillsStore.selected && skillKey(skillsStore.selected) === skillKey(ref);
	}

	/** Never drop edits on a click — ask, the way a text editor would. */
	function guard(): boolean {
		if (!skillsStore.dirty) return true;
		return confirm('Some changes are not saved. Discard them?');
	}

	function pick(ref: SkillRef) {
		if (!guard()) return;
		creating = false;
		skillsStore.open(ref);
	}

	function startCreate() {
		if (!guard()) return;
		skillsStore.close();
		creating = true;
		newCategory = skillsStore.categories[0] ?? '';
		newName = '';
		newDescription = '';
	}

	let slug = $derived(slugifySkillName(newName));
	let categorySlug = $derived(slugifySkillName(newCategory));
	let canCreate = $derived(
		!submitting && isValidSkillName(slug) && isValidSkillName(categorySlug)
	);

	async function submitCreate() {
		if (!canCreate) return;
		submitting = true;
		const ok = await skillsStore.create(categorySlug, slug, newDescription.trim());
		submitting = false;
		if (ok) creating = false;
	}

	function tryClose() {
		if (!guard()) return;
		skillsStore.close();
		creating = false;
		onclose();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			tryClose();
		} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
			event.preventDefault();
			if (skillsStore.dirty && !overLimit) skillsStore.save();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Modal {open} title="Skills" width={1080} fill onclose={tryClose}>
	{#snippet subtitle()}
		{#if skillsStore.state === 'failed'}
			list unreadable
		{:else if skillsStore.state === 'disabled'}
			unavailable
		{:else}
			files on the Pi · a gateway restart may be needed
		{/if}
	{/snippet}

	{#if skillsStore.state === 'failed'}
		<div class="unavailable">
			<p>The skill list could not be read.</p>
			<p class="muted small">{skillsStore.loadError}</p>
			<p class="muted small">
				The directory may well be mounted and healthy: this screen only says that
				the request failed.
			</p>
			<button onclick={() => skillsStore.refresh()} disabled={skillsStore.loading}>
				{skillsStore.loading ? 'Reading…' : 'Retry'}
			</button>
		</div>
	{:else if skillsStore.state === 'disabled'}
		<div class="unavailable">
			<p>Skill editing is turned off.</p>
			<p class="muted small">
				The skills directory is not mounted in the container. Add the
				<code>/skills</code> volume and the <code>SKILLS_DIR</code> variable (see
				<code>docker-compose.yml</code>), then run <code>docker compose up -d</code> again.
			</p>
		</div>
	{:else}
		<div class="split">
			<aside>
				<div class="tools">
					<input
						bind:value={query}
						placeholder="Filter…"
						aria-label="Filter skills"
						type="search"
					/>
					<button class="new" onclick={startCreate}>＋ New</button>
				</div>

				<div class="list">
					{#if skillsStore.loading && skillsStore.entries.length === 0}
						<p class="none">Loading…</p>
					{:else if groups.length === 0}
						<p class="none">No skills.</p>
					{/if}

					{#each groups as group (group.category)}
						<div class="group">
							<div class="cat">
								<span class="cat-name">{group.category}</span>
								{#if group.description}
									<button
										class="desc"
										class:sel={isSelected(group.description)}
										title="Edit the category description"
										onclick={() =>
											pick({
												category: group.category,
												skill: null,
												file: DESCRIPTION_FILE
											})}>description</button
									>
								{/if}
							</div>
							{#each group.skills as entry (skillKey(entry))}
								<button
									class="row"
									class:sel={isSelected(entry)}
									onclick={() => pick(entry)}
								>
									<span class="label">{entry.skill}</span>
									<span class="meta">{formatBytes(entry.size)}</span>
									<span class="meta">{relativeTime(entry.modified)}</span>
								</button>
							{/each}
						</div>
					{/each}
				</div>
			</aside>

			<section class="editor">
				{#if creating}
					<div class="form">
						<h3>New skill</h3>
						<label>
							Category
							<input
								bind:value={newCategory}
								list="skill-categories"
								placeholder="productivity"
							/>
						</label>
						<datalist id="skill-categories">
							{#each skillsStore.categories as category (category)}
								<option value={category}></option>
							{/each}
						</datalist>
						<label>
							Skill name
							<input bind:value={newName} placeholder="my-tech-watch" />
						</label>
						<label>
							Description (one sentence: when Yadai should use it)
							<input bind:value={newDescription} placeholder="Optional" />
						</label>
						<p class="muted small">
							Will be created at
							<code>{categorySlug || '<category>'}/{slug || '<name>'}/SKILL.md</code>
							{#if !skillsStore.categories.includes(categorySlug) && categorySlug}
								· new category, with its <code>DESCRIPTION.md</code>
							{/if}
						</p>
						<div class="actions">
							<button onclick={() => (creating = false)}>Cancel</button>
							<button class="primary" disabled={!canCreate} onclick={submitCreate}>
								{submitting ? 'Creating…' : 'Create'}
							</button>
						</div>
					</div>
				{:else if skillsStore.selected}
					<div class="edit-head">
						<div class="path">
							<code
								>{skillsStore.selected.category}{skillsStore.selected.skill
									? '/' + skillsStore.selected.skill
									: ''}/{skillsStore.selected.file}</code
							>
							{#if skillsStore.dirty}<span class="dot" title="Not saved">●</span>{/if}
						</div>
						<span class="muted small" class:over={overLimit}>
							{skillsStore.content.length} characters · {formatBytes(bytes)}
						</span>
					</div>

					{#if skillsStore.loadingFile}
						<p class="none">Loading…</p>
					{:else}
						<textarea
							bind:value={skillsStore.content}
							spellcheck="false"
							aria-label="File content"
						></textarea>
					{/if}

					<div class="edit-foot">
						<span class="muted small">
							{#if skillsStore.savedOnce}
								Saved to disk. A new skill is only picked up after
								<code>systemctl --user restart hermes-gateway</code>.
							{:else}
								Writes straight to the file. ⌘/Ctrl + S saves.
							{/if}
						</span>
						<button
							class="primary"
							disabled={!skillsStore.dirty || skillsStore.saving || overLimit}
							onclick={() => skillsStore.save()}
						>
							{skillsStore.saving ? 'Saving…' : 'Save'}
						</button>
					</div>
				{:else}
					<p class="none">Pick a skill on the left, or create one.</p>
				{/if}
			</section>
		</div>
{/if}
</Modal>

<style>
	h3 {
		margin: 0 0 4px;
		font-size: 14px;
		font-weight: 600;
	}
	.unavailable {
		padding: 26px 20px;
		text-align: center;
	}
	.unavailable p {
		margin: 0 auto 8px;
		max-width: 460px;
	}
	.unavailable button {
		margin-top: 8px;
		padding: 7px 15px;
		min-height: 34px;
		border-radius: 999px;
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		font-size: 13px;
	}
	.unavailable button:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	.split {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	aside {
		width: 288px;
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-soft);
		min-height: 0;
	}
	.tools {
		display: flex;
		gap: 6px;
		padding: 10px;
		border-bottom: 1px solid var(--border-soft);
	}
	.tools input {
		flex: 1;
		min-width: 0;
		padding: 6px 9px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13px;
	}
	.new {
		flex: 0 0 auto;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 13px;
	}
	.new:hover {
		background: var(--bg-hover);
	}
	.list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
	}
	.group {
		margin-bottom: 10px;
	}
	.cat {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 8px;
	}
	.cat-name {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.desc {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-faint);
		text-decoration: underline;
	}
	.desc:hover,
	.desc.sel {
		color: var(--text);
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: 7px;
		text-align: left;
		font-size: 13.5px;
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.row.sel {
		background: var(--bg-hover);
		color: var(--text);
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-faint);
	}
	.editor {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.edit-head,
	.edit-foot {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 14px;
	}
	.edit-head {
		border-bottom: 1px solid var(--border-soft);
	}
	.edit-foot {
		border-top: 1px solid var(--border-soft);
	}
	.edit-foot .muted {
		flex: 1;
		min-width: 0;
	}
	.path {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
		overflow: hidden;
	}
	.path code {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
	}
	.dot {
		flex: 0 0 auto;
		color: var(--accent);
		font-size: 10px;
	}
	textarea {
		flex: 1;
		min-height: 0;
		width: 100%;
		padding: 14px;
		background: var(--bg);
		border: none;
		resize: none;
		outline: none;
		color: var(--text);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 13px;
		line-height: 1.55;
		tab-size: 2;
	}
	.form {
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-width: 520px;
	}
	.form label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-muted);
	}
	.form input {
		padding: 7px 10px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13.5px;
		color: var(--text);
	}
	.form input:focus {
		border-color: var(--border);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.actions button,
	.edit-foot button {
		padding: 6px 13px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 13px;
	}
	.actions button:hover:not(:disabled),
	.edit-foot button:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	button.primary:not(:disabled) {
		background: var(--bg-sunken);
		font-weight: 600;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 12px;
	}
	.over {
		color: var(--danger);
	}
	.none {
		padding: 24px;
		text-align: center;
		color: var(--text-faint);
		font-size: 13px;
	}
	code {
		padding: 1px 5px;
		background: var(--bg-sunken);
		border-radius: 4px;
		font-size: 11.5px;
	}

	@media (max-width: 820px) {
		.split {
			flex-direction: column;
		}
		aside {
			width: auto;
			border-right: none;
			border-bottom: 1px solid var(--border-soft);
			max-height: 38%;
		}
		.editor {
			min-height: 0;
		}
	}
</style>
