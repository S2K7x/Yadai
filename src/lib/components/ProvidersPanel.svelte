<script lang="ts">
	import { untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import { shouldLoadPanel } from '$lib/availability';
	import { providersStore } from '$lib/stores/providers.svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import {
		accountSummary,
		filterProviderGroups,
		flowKind,
		isConnected,
		isGroupConfigured,
		secondsLeft,
		type OauthProvider
	} from '$lib/providers';
	import { shortModelName } from '$lib/models';

	interface Props {
		open: boolean;
		onclose: () => void;
	}
	let { open, onclose }: Props = $props();

	type Tab = 'keys' | 'accounts' | 'model';
	let tab = $state<Tab>('keys');
	let query = $state('');

	// Load once. Listing providers costs two dashboard calls, one of which walks
	// the credential store — not something to repeat on a Pi while the panel
	// just sits there. A *failed* read is the one case worth retrying, so
	// closing and reopening heals a blip — see `shouldLoadPanel`.
	// The state reads are untracked so this fires once per opening and not once
	// per store mutation: `failed` is now a state that *asks* to reload, so an
	// effect that re-ran on it would retry in a tight loop against the very
	// thing that just failed. `open` is the only dependency.
	$effect(() => {
		if (!open) return;
		if (untrack(() => shouldLoadPanel(providersStore.state, providersStore.loading))) {
			providersStore.refresh();
		}
	});

	let groups = $derived(filterProviderGroups(providersStore.keys, query));

	// Only providers Hermes can actually route to are offered as a default:
	// picking an unauthenticated one guarantees a failed turn.
	let usableProviders = $derived(
		(chat.models?.providers ?? []).filter((p) => p.authenticated && p.models.length > 0)
	);
	let modelProvider = $state('');
	let modelName = $state('');

	$effect(() => {
		if (!modelProvider && chat.models?.provider) modelProvider = chat.models.provider;
	});
	let providerModels = $derived(
		usableProviders.find((p) => p.slug === modelProvider)?.models ?? []
	);
	$effect(() => {
		if (providerModels.length && !providerModels.includes(modelName)) {
			modelName = providerModels.includes(chat.models?.model ?? '')
				? (chat.models?.model ?? '')
				: providerModels[0];
		}
	});

	let flow = $derived(providersStore.flow);
	let remaining = $derived(flow ? secondsLeft(flow, providersStore.now) : 0);

	function close() {
		// Leave the pending login alone rather than cancelling it silently: the
		// user may be finishing the flow in another tab.
		onclose();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	}

	function accountAction(provider: OauthProvider): string {
		return flowKind(provider) === 'external' ? 'Via the CLI' : 'Connect';
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Modal {open} title="Providers" width={760} fill onclose={close}>
	{#snippet subtitle()}
		{#if providersStore.state === 'failed'}
			list unreadable
		{:else if providersStore.state === 'disabled'}
			unavailable
		{:else}
			Yadai's keys and accounts · a gateway restart may be needed
		{/if}
	{/snippet}

	{#if providersStore.state === 'failed'}
		<div class="unavailable">
			<p>The providers could not be read.</p>
			<p class="muted small">{providersStore.loadError}</p>
			<p class="muted small">
				The dashboard may well be configured and healthy: this screen only says that
				the request failed.
			</p>
			<button onclick={() => providersStore.refresh()} disabled={providersStore.loading}>
				{providersStore.loading ? 'Reading…' : 'Retry'}
			</button>
		</div>
	{:else if providersStore.state === 'disabled'}
		<div class="unavailable">
			<p>Provider management is unavailable.</p>
			<p class="muted small">{providersStore.message}</p>
			<p class="muted small">
				The Hermes dashboard runs as a user service
				(<code>systemctl --user status hermes-dashboard</code>) on
				<code>127.0.0.1:9119</code>. Its token is
				<code>HERMES_DASHBOARD_SESSION_TOKEN</code> in
				<code>~/.hermes/dashboard.env</code>; copy it into
				<code>HERMES_DASHBOARD_TOKEN</code>.
			</p>
			<button onclick={() => providersStore.refresh()}>Retry</button>
		</div>
	{:else}
		<nav class="tabs">
			<button class:sel={tab === 'keys'} onclick={() => (tab = 'keys')}>API keys</button>
			<button class:sel={tab === 'accounts'} onclick={() => (tab = 'accounts')}>Accounts</button>
			<button class:sel={tab === 'model'} onclick={() => (tab = 'model')}>
				Default model
			</button>
		</nav>

		<div class="body">
			{#if providersStore.loading && providersStore.keys.length === 0}
				<p class="none">Loading…</p>
			{:else if tab === 'keys'}
				<div class="tools">
					<input
						bind:value={query}
						placeholder="Filter providers…"
						aria-label="Filter providers"
						type="search"
					/>
				</div>

				{#if groups.length === 0}
					<p class="none">No provider matches.</p>
				{/if}

				{#each groups as group (group.provider)}
					<section class="card">
						<div class="card-head">
							<span class="name">{group.label}</span>
							<span class="pill" class:on={isGroupConfigured(group)}>
								{isGroupConfigured(group) ? 'Configured' : 'Not configured'}
							</span>
						</div>
						{#each group.keys as entry (entry.key)}
							<div class="var">
								<div class="var-head">
									<code>{entry.key}</code>
									{#if entry.isSet}
										<span class="redacted">{entry.redacted ?? '••••'}</span>
									{:else}
										<span class="muted small">not set</span>
									{/if}
									<span class="spacer"></span>
									{#if providersStore.editing !== entry.key}
										<button onclick={() => providersStore.edit(entry.key)}>
											{entry.isSet ? 'Replace' : 'Set'}
										</button>
										{#if entry.isSet}
											<button
												class="danger"
												disabled={providersStore.saving}
												onclick={() => {
													if (confirm(`Remove ${entry.key} from Yadai's configuration?`))
														providersStore.deleteKey(entry.key);
												}}>Delete</button
											>
										{/if}
									{/if}
								</div>

								{#if entry.description}
									<p class="muted small desc">
										{entry.description}
										{#if entry.url}
											· <a href={entry.url} target="_blank" rel="noreferrer noopener">
												get a key
											</a>
										{/if}
									</p>
								{/if}

								{#if providersStore.editing === entry.key}
									<div class="editor">
										<!-- svelte-ignore a11y_autofocus -->
										<input
											type="password"
											autocomplete="off"
											spellcheck="false"
											autofocus
											bind:value={providersStore.draft}
											placeholder="Paste the key"
											aria-label={`Value of ${entry.key}`}
											onkeydown={(e) => {
												if (e.key === 'Enter') providersStore.saveKey();
											}}
										/>
										<button
											disabled={!providersStore.draft.trim() || providersStore.validating}
											onclick={() => providersStore.validate()}
										>
											{providersStore.validating ? 'Checking…' : 'Check'}
										</button>
										<button
											class="primary"
											disabled={!providersStore.draft.trim() || providersStore.saving}
											onclick={() => providersStore.saveKey()}
										>
											{providersStore.saving ? 'Saving…' : 'Save'}
										</button>
										<button onclick={() => providersStore.cancelEdit()}>Cancel</button>
									</div>
									{#if providersStore.validationHint}
										<p class="muted small">{providersStore.validationHint}</p>
									{/if}
									<p class="muted small">
										The key is written to <code>~/.hermes/.env</code> by Hermes itself, which
										also updates the copies in <code>config.yaml</code>. It is never
										sent back in clear text to this browser.
									</p>
								{/if}
							</div>
						{/each}
					</section>
				{/each}
			{:else if tab === 'accounts'}
				{#if flow}
					<section class="card flow">
						<div class="card-head">
							<span class="name">{flow.providerName}</span>
							{#if flow.phase === 'awaiting'}
								<span class="pill">expires in {Math.floor(remaining / 60)} min {remaining % 60}s</span>
							{/if}
						</div>

						{#if flow.phase === 'awaiting' && flow.kind === 'device_code'}
							<p>
								Open
								<a href={flow.verificationUrl} target="_blank" rel="noreferrer noopener">
									{flow.verificationUrl}
								</a>
								and enter this code:
							</p>
							<p class="code">{flow.userCode}</p>
							<p class="muted small">
								This page checks with Hermes every
								{Math.round(flow.pollIntervalMs / 1000)} s until the provider answers.
							</p>
						{:else if flow.phase === 'awaiting'}
							<p>
								Open
								<a href={flow.authUrl} target="_blank" rel="noreferrer noopener">
									the authorisation page
								</a>, then paste the code shown at the end here:
							</p>
							<div class="editor">
								<input
									bind:value={providersStore.code}
									placeholder="Authorisation code"
									aria-label="Authorisation code"
									spellcheck="false"
								/>
								<button
									class="primary"
									disabled={!providersStore.code.trim() || providersStore.submitting}
									onclick={() => providersStore.submitCode()}
								>
									{providersStore.submitting ? 'Submitting…' : 'Submit'}
								</button>
							</div>
						{:else}
							<p class:ok={flow.phase === 'approved'} class:ko={flow.phase !== 'approved'}>
								{flow.message}
							</p>
						{/if}

						<div class="actions">
							<button onclick={() => providersStore.cancelFlow()}>
								{flow.phase === 'awaiting' ? 'Cancel' : 'Close'}
							</button>
						</div>
					</section>
				{/if}

				{#each providersStore.accounts as provider (provider.id)}
					<section class="card">
						<div class="card-head">
							<span class="name">{provider.name}</span>
							<span class="pill" class:on={isConnected(provider)}>
								{isConnected(provider) ? 'Connected' : 'Not connected'}
							</span>
						</div>
						<p class="muted small desc">
							{accountSummary(provider)}
							{#if provider.docs_url}
								· <a href={provider.docs_url} target="_blank" rel="noreferrer noopener">docs</a>
							{/if}
						</p>

						{#if flowKind(provider) === 'external'}
							<p class="muted small">
								Run <code>{provider.cli_command}</code> on the Pi: Yadai cannot
								drive this flow for you.
							</p>
						{/if}

						<div class="actions">
							{#if !isConnected(provider) && flowKind(provider) !== 'external'}
								<button
									class="primary"
									disabled={!!flow || providersStore.starting !== null}
									onclick={() => providersStore.startOauth(provider)}
								>
									{providersStore.starting === provider.id ? 'Starting…' : accountAction(provider)}
								</button>
							{/if}
							{#if isConnected(provider) && provider.disconnectable}
								<button
									class="danger"
									disabled={providersStore.saving}
									onclick={() => {
										if (confirm(`Disconnect ${provider.name}?`)) providersStore.disconnect(provider);
									}}>Disconnect</button
								>
							{:else if isConnected(provider) && provider.disconnect_command}
								<span class="muted small">
									To disconnect: <code>{provider.disconnect_command}</code>
								</span>
							{:else if isConnected(provider) && provider.disconnect_hint}
								<span class="muted small">{provider.disconnect_hint}</span>
							{/if}
						</div>
					</section>
				{/each}
			{:else}
				<section class="card">
					<div class="card-head">
						<span class="name">Yadai's default model</span>
						{#if chat.models}
							<span class="pill on">{shortModelName(chat.models.model)}</span>
						{/if}
					</div>
					<p class="muted small desc">
						Written to <code>config.yaml</code> and applied to <strong>new</strong>
						chats. To change the model of the open conversation, use the picker
						at the top of the screen.
					</p>

					{#if usableProviders.length === 0}
						<p class="muted small">
							No authenticated provider yet. Set a key or connect an
							account in the other tabs.
						</p>
					{:else}
						<div class="editor">
							<select bind:value={modelProvider} aria-label="Provider">
								{#each usableProviders as provider (provider.slug)}
									<option value={provider.slug}>{provider.name}</option>
								{/each}
							</select>
							<select bind:value={modelName} aria-label="Model">
								{#each providerModels as model (model)}
									<option value={model}>{model}</option>
								{/each}
							</select>
							<button
								class="primary"
								disabled={!modelName || providersStore.switchingModel}
								onclick={() => providersStore.setDefaultModel(modelProvider, modelName)}
							>
								{providersStore.switchingModel ? 'Applying…' : 'Set as default'}
							</button>
						</div>
					{/if}

					{#if providersStore.confirmModel}
						<div class="warn">
							<p>{providersStore.confirmModel.message}</p>
							<div class="actions">
								<button onclick={() => providersStore.dismissConfirm()}>Cancel</button>
								<button
									class="primary"
									disabled={providersStore.switchingModel}
									onclick={() =>
										providersStore.setDefaultModel(
											providersStore.confirmModel!.provider,
											providersStore.confirmModel!.model,
											true
										)}>Confirm anyway</button
								>
							</div>
						</div>
					{/if}
				</section>
			{/if}
		</div>
{/if}
</Modal>

<style>
	.tabs {
		display: flex;
		gap: 4px;
		padding: 8px 12px 0;
		border-bottom: 1px solid var(--border-soft);
	}
	.tabs button {
		padding: 6px 12px 8px;
		font-size: 13px;
		color: var(--text-muted);
		border-bottom: 2px solid transparent;
	}
	.tabs button:hover {
		color: var(--text);
	}
	.tabs button.sel {
		color: var(--text);
		border-bottom-color: var(--accent);
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px;
	}
	.tools {
		padding: 0 2px 10px;
	}
	.tools input {
		width: 100%;
		padding: 7px 10px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13px;
		color: var(--text);
	}
	.card {
		margin-bottom: 10px;
		padding: 11px 13px;
		border: 1px solid var(--border-soft);
		border-radius: 10px;
	}
	.card.flow {
		border-color: var(--accent);
	}
	.card-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.name {
		flex: 1;
		min-width: 0;
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill {
		flex: 0 0 auto;
		padding: 1px 8px;
		border: 1px solid var(--border-soft);
		border-radius: 20px;
		font-size: 11px;
		color: var(--text-faint);
	}
	.pill.on {
		color: var(--text);
		border-color: var(--border);
	}
	.desc {
		margin: 4px 0 0;
	}
	.var {
		margin-top: 9px;
		padding-top: 9px;
		border-top: 1px solid var(--border-soft);
	}
	.var-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.spacer {
		flex: 1;
	}
	.redacted {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12px;
		color: var(--text-muted);
	}
	.editor {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.editor input {
		flex: 1;
		min-width: 180px;
		padding: 6px 9px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13px;
		color: var(--text);
	}
	.editor select {
		flex: 1;
		min-width: 150px;
		padding: 6px 9px;
		background: var(--bg-sunken);
		border: 1px solid var(--border-soft);
		border-radius: 7px;
		font-size: 13px;
		color: var(--text);
	}
	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 9px;
	}
	.warn {
		margin-top: 10px;
		padding: 9px 11px;
		border: 1px solid var(--danger);
		border-radius: 8px;
	}
	.warn p {
		margin: 0;
		font-size: 13px;
	}
	button {
		padding: 5px 11px;
		border: 1px solid var(--border);
		border-radius: 7px;
		font-size: 12.5px;
	}
	.tabs button {
		border: none;
		border-radius: 0;
	}
	button:hover:not(:disabled) {
		background: var(--bg-hover);
	}
	button.primary:not(:disabled) {
		background: var(--bg-sunken);
		font-weight: 600;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.unavailable {
		padding: 26px 20px;
		text-align: center;
	}
	.unavailable p {
		margin: 0 auto 8px;
		max-width: 480px;
	}
	.code {
		margin: 8px 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 22px;
		letter-spacing: 0.16em;
		text-align: center;
	}
	.ok {
		color: var(--text);
	}
	.ko {
		color: var(--danger);
	}
	p {
		font-size: 13px;
	}
	.muted {
		color: var(--text-muted);
	}
	.small {
		font-size: 12px;
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
	a {
		color: var(--text);
	}
</style>
