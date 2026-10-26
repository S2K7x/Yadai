<script lang="ts">
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	import { firstPendingApproval } from '$lib/approvals';
	import ToolSteps from './ToolSteps.svelte';
	import type { UiMessage } from '$lib/transcript';

	interface Props {
		message: UiMessage;
		/** Briefly outlined, after the palette jumped the thread to it. */
		flash?: boolean;
		onfork?: () => void;
		onreload?: () => void;
		onresend?: () => void;
	}
	let { message, flash = false, onfork, onreload, onresend }: Props = $props();

	/**
	 * A turn that ended waiting on an approval this UI cannot grant.
	 *
	 * Left alone, the agent's own prose points at a "confirmation window" that
	 * does not exist on this path — see `$lib/approvals` for why there is no
	 * button to put here, and what does work instead.
	 */
	let approval = $derived(firstPendingApproval(message.steps));
	let approvalCopied = $state(false);
	function copyCommand() {
		if (!approval) return;
		navigator.clipboard.writeText(approval.command);
		approvalCopied = true;
		setTimeout(() => (approvalCopied = false), 1400);
	}

	let copied = $state(false);
	function copy() {
		navigator.clipboard.writeText(message.content);
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}
</script>

<!-- `data-mid` is how the page finds this turn again when a search result is
     chosen: message ids come from Hermes and are not safe as DOM ids. -->
<article class="msg {message.role}" class:flash data-mid={message.id}>
	{#if message.role === 'user'}
		<div class="bubble">
			<!-- Read out before the text: a transcript of bare paragraphs gives
			     no clue who is speaking. Visible attribution is the layout. -->
			<span class="sr-only">You:</span>
			{#if message.images.length}
				<div class="images">
					{#each message.images as src, i (i)}
						<img {src} alt="attachment {i + 1}" />
					{/each}
				</div>
			{/if}
			<div class="user-text">{message.content}</div>
		</div>
	{:else}
		<div class="reply">
			<span class="sr-only">Yadai:</span>
			<ToolSteps steps={message.steps} reasoning={message.reasoning} streaming={message.streaming} />

			{#if message.content}
				<div class="body" class:typing={message.streaming}>
					<Markdown source={message.content} streaming={message.streaming} />
				</div>
			{:else if message.streaming && message.steps.length === 0}
				<div class="thinking"><span></span><span></span><span></span></div>
			{/if}

			{#if approval}
				<div class="approval">
					<p class="ap-head">
						<Icon name="key" size={15} /> Approval required — cannot be granted here
					</p>
					<pre class="ap-cmd">{approval.command}</pre>
					{#if approval.reason}<p class="ap-why">Reason: {approval.reason}.</p>{/if}
					<p class="ap-body">
						Hermes only offers an approval button on its other execution path, the one that does
						not reload a conversation's history. This interface chose the thread's memory — so the
						command was not run, and there is nothing left to grant: the request does not wait, it
						has already lapsed.
					</p>
					<p class="ap-body">
						To run it: run it yourself on the Pi, or ask again from the <code>hermes</code> CLI
						or Telegram, where Yadai can ask the question.
					</p>
					<div class="ap-actions">
						<button onclick={copyCommand}>
							{approvalCopied ? 'copied' : 'copy command'}
						</button>
					</div>
				</div>
			{/if}

			{#if message.error}
				<div class="error"><Icon name="warning" size={15} /> {message.error}</div>
			{/if}

			{#if message.detached}
				<div class="detached">
					{#if message.detached === 'truncated'}
						The stream stopped before the turn finished: this text is incomplete. The agent is
						finishing in the background and its full answer will be in the conversation.
					{:else}
						Display detached. Yadai has no stop for this kind of turn: the agent is finishing in
						the background and its answer will be in the conversation.
					{/if}
					<button onclick={onreload}>Reload</button>
				</div>
			{/if}

			{#if !message.streaming && (message.content || message.error)}
				<div class="actions">
					{#if message.content}
						<button onclick={copy}>{copied ? 'copied' : 'copy'}</button>
					{/if}
					{#if onresend}<button onclick={onresend}>resend</button>{/if}
					{#if onfork}<button onclick={onfork}>branch here</button>{/if}
				</div>
			{/if}
		</div>
	{/if}
</article>

<style>
	.msg {
		display: flex;
		margin: 0 0 12px;
	}
	.msg.user {
		justify-content: flex-end;
	}
	/* Both bubbles are cards now: the thread sits on the sunken ground and
	   nothing is outlined, so a message is told apart from the page by its
	   fill and its lift. The clipped corner is what still says who is
	   speaking once both of them are cards. */
	.bubble {
		max-width: min(78%, 640px);
		padding: 13px 19px;
		background: var(--user-bubble);
		color: var(--user-ink);
		border-radius: var(--radius-bubble) var(--radius-bubble) 8px var(--radius-bubble);
		box-shadow: var(--shadow-card);
	}
	.user-text {
		white-space: pre-wrap;
		word-break: break-word;
	}
	.images {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 8px;
	}
	.images img {
		max-width: 180px;
		max-height: 180px;
		border-radius: var(--radius-card);
		object-fit: cover;
	}
	/* The assistant answers in a card of its own, so the blocks a reply
	   contains (code, tables) read as insets rather than as the page. */
	.reply {
		width: 100%;
		min-width: 0;
		padding: 16px 20px;
		background: var(--bg-raised);
		border-radius: var(--radius-bubble) var(--radius-bubble) var(--radius-bubble) 8px;
		box-shadow: var(--shadow-card);
	}
	/* Blinking caret after the last rendered character, like Claude's. The
	   markdown re-render is debounced, so the caret is what tells the user
	   text is still arriving between parses. */
	.body.typing :global(> .md > :last-child::after) {
		content: '';
		display: inline-block;
		width: 2px;
		height: 1em;
		margin-left: 2px;
		vertical-align: text-bottom;
		background: var(--accent);
		animation: caret 1s steps(2) infinite;
	}
	@keyframes caret {
		0%,
		50% {
			opacity: 1;
		}
		51%,
		100% {
			opacity: 0;
		}
	}

	/* Where did it say that? — the palette answers with an excerpt, this says
	   where. Two and a half seconds, then the thread looks untouched again. */
	.msg.flash .bubble,
	.msg.flash .reply {
		animation: flash 2.4s ease-out;
	}
	@keyframes flash {
		0%,
		35% {
			box-shadow: var(--shadow-card), 0 0 0 2px var(--focus);
		}
		100% {
			box-shadow: var(--shadow-card), 0 0 0 2px transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.msg.flash .bubble,
		.msg.flash .reply {
			animation-duration: 0.01s;
			box-shadow: var(--shadow-card), 0 0 0 2px var(--focus);
		}
	}

	.detached {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 10px;
		padding: 11px 16px;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
		color: var(--text-muted);
		font-size: 13px;
	}
	.detached button {
		padding: 7px 14px;
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		font-size: 12.5px;
		color: var(--text);
	}
	.detached button:hover {
		background: var(--bg-hover);
	}
	.approval {
		margin-top: 12px;
		padding: 13px 16px;
		border-radius: var(--radius-card);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1.5px var(--accent-soft);
		font-size: 13px;
		line-height: 1.55;
	}
	.ap-head {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 0 0 9px;
		font-weight: 600;
		color: var(--accent);
	}
	.ap-cmd {
		margin: 0 0 9px;
		padding: 9px 12px;
		border-radius: var(--radius-card);
		background: var(--code-bg);
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.ap-why {
		margin: 0 0 8px;
		color: var(--text-muted);
	}
	.ap-body {
		margin: 0 0 8px;
		color: var(--text-muted);
	}
	.ap-body:last-of-type {
		margin-bottom: 10px;
	}
	.ap-body code {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 11.5px;
		padding: 1px 5px;
		border-radius: 5px;
		background: var(--code-bg);
	}
	.ap-actions button {
		min-height: 36px;
		padding: 6px 14px;
		border-radius: var(--radius-pill);
		background: var(--bg-raised);
		box-shadow: var(--shadow-card);
		font-size: 12.5px;
		color: var(--text);
	}
	.ap-actions button:hover {
		background: var(--bg-hover);
	}
	.error {
		margin-top: 10px;
		padding: 11px 16px;
		border-radius: var(--radius-card);
		background: var(--danger-soft);
		color: var(--danger);
		font-size: 13.5px;
	}
	.actions {
		display: flex;
		gap: 6px;
		margin-top: 12px;
		opacity: 0;
		transition: opacity 0.15s;
	}
	/* The latest answer keeps its actions on show, the way Claude.ai does: it
	   is the one you are most likely to copy or resend, and the row's space is
	   reserved either way — hidden, it read as an empty band under the card. */
	.msg:hover .actions,
	.msg:last-of-type .actions,
	.actions:focus-within {
		opacity: 1;
	}
	/* No hover on touch, so the pills are always shown — at full strength and
	   in the muted ink rather than the faint one: faded twice over (65 % of
	   --text-faint) they were measured well under 3:1 on the reply card. */
	@media (hover: none) {
		.actions {
			opacity: 1;
		}
		.actions button {
			color: var(--text-muted);
		}
	}
	.actions button {
		padding: 6px 14px;
		font-size: 12px;
		color: var(--text-faint);
		background: var(--bg-sunken);
		border-radius: var(--radius-pill);
	}
	.actions button:hover {
		color: var(--text);
		background: var(--bg-hover);
	}
	/* Touch: these pills are always visible (there is no hover to reveal them),
	   so they are real targets and have to be thumb-sized. */
	@media (max-width: 820px) {
		.actions button {
			min-height: 44px;
			padding: 6px 16px;
		}
		.reply {
			padding: 14px 16px;
		}
		.bubble {
			padding: 12px 16px;
		}
	}
	.thinking {
		display: flex;
		gap: 5px;
		padding: 6px 0;
	}
	.thinking span {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-faint);
		animation: bounce 1.2s ease-in-out infinite;
	}
	.thinking span:nth-child(2) {
		animation-delay: 0.15s;
	}
	.thinking span:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes bounce {
		0%,
		60%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		30% {
			transform: translateY(-4px);
			opacity: 1;
		}
	}
</style>
