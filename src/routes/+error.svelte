<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="wrap">
	<h1>{page.status}</h1>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	<div class="actions">
		<button onclick={() => location.reload()}>Reload</button>
		<a href="/">Back to chat</a>
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		height: 100dvh;
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
	}
	h1 {
		margin: 0;
		font-size: 42px;
		font-weight: 600;
		color: var(--text-faint);
	}
	p {
		margin: 0;
		max-width: 420px;
	}
	.actions {
		display: flex;
		gap: 10px;
		margin-top: 10px;
	}
	button,
	a {
		padding: 7px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		font-size: 14px;
		color: var(--text);
		text-decoration: none;
	}
	button:hover,
	a:hover {
		background: var(--bg-hover);
	}
</style>
