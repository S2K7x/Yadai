<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { toasts } from '$lib/stores/toast.svelte';

	let { children } = $props();

	onMount(() => {
		// The cached palette is already painted by the early script in app.html;
		// this reconciles it with the server, which is the truth.
		void theme.init();

		if ('serviceWorker' in navigator && location.protocol === 'https:') {
			navigator.serviceWorker.register('/service-worker.js').catch(() => {});
		}

		// Last-resort net for bugs that escape the stores. Without this a
		// thrown error in an effect leaves the UI silently frozen.
		const onError = (event: ErrorEvent) => toasts.push('error', `Error: ${event.message}`);
		const onRejection = (event: PromiseRejectionEvent) => {
			const reason = event.reason;
			if (reason?.name === 'AbortError') return; // deliberate cancellation
			toasts.push('error', `Error: ${reason?.message ?? String(reason)}`);
		};
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onRejection);

		// The browser going offline is worth saying out loud — otherwise it
		// looks like Hermes died.
		const onOffline = () => toasts.push('error', 'Device offline.');
		const onOnline = () => toasts.success('Network connection restored.');
		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);

		return () => {
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
		};
	});
</script>

<svelte:head>
	<title>Yadai</title>
	<meta name="description" content="Yadai — a private web interface for Hermes Agent" />
</svelte:head>

{@render children()}

<Toasts />
