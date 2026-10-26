/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';
import { base64UrlToBytes } from '$lib/push';

/**
 * App-shell cache only.
 *
 * Nothing under /api is ever cached: session lists, transcripts and the SSE
 * stream must always hit the server, and a stale cached transcript would be
 * worse than an offline error. The worker exists so the PWA opens instantly
 * and survives a dropped tailnet, not to work offline.
 */

const CACHE = `yadai-shell-${version}`;
const SHELL = [...build, ...files];

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

/**
 * Every push MUST show a notification.
 *
 * `userVisibleOnly: true` is not a formality: Safari revokes the subscription
 * outright if a push is handled without displaying anything, and Chrome shows
 * its own "site updated in the background" notice. So the handler always ends
 * in `showNotification`, even when the payload is missing or unparseable.
 */
sw.addEventListener('push', (event) => {
	let title = 'Yadai';
	let body = 'The turn is finished.';
	let url = '/';
	let tag = 'yadai';
	try {
		const data = event.data?.json() as Partial<{
			title: string;
			body: string;
			url: string;
			tag: string;
		}> | null;
		if (data) {
			if (typeof data.title === 'string' && data.title) title = data.title;
			if (typeof data.body === 'string' && data.body) body = data.body;
			if (typeof data.url === 'string' && data.url.startsWith('/')) url = data.url;
			if (typeof data.tag === 'string' && data.tag) tag = data.tag;
		}
	} catch {
		/* fall back to the generic notification below */
	}

	event.waitUntil(
		sw.registration.showNotification(title, {
			body,
			tag,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			data: { url }
		})
	);
});

/** Focus an open window on the conversation, or open one at the deep link. */
sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = (event.notification.data as { url?: string } | undefined)?.url || '/';
	event.waitUntil(
		(async () => {
			const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of clients) {
				if (new URL(client.url).origin !== location.origin) continue;
				await client.focus();
				// Same window, right conversation. navigate() is rejected by
				// some platforms (and by Safari when the client is not
				// controlled), so a failure just leaves the window focused.
				await client.navigate(target).catch(() => undefined);
				return;
			}
			await sw.clients.openWindow(target);
		})()
	);
});

/**
 * The push service rotated our subscription.
 *
 * Fired without a page open, so re-subscribing has to happen here or the device
 * silently stops receiving anything. The VAPID key comes back from the server,
 * which is also where the new endpoint has to be recorded.
 */
sw.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			try {
				const config = await fetch('/api/push').then((r) => r.json());
				if (!config?.publicKey) return;
				const subscription = await sw.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToBytes(config.publicKey)
				});
				await fetch('/api/push', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(subscription.toJSON())
				});
			} catch {
				/* the settings panel will offer to re-enable on the next visit */
			}
		})()
	);
}) as EventListener);

sw.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== location.origin) return;
	if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

	// Cache-first for immutable build assets, network-first for everything
	// else so a deploy is picked up without a hard reload.
	const isAsset = SHELL.includes(url.pathname);
	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			if (isAsset) {
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
			}
			try {
				const response = await fetch(request);
				if (response.ok && response.type === 'basic') {
					cache.put(request, response.clone());
				}
				return response;
			} catch (err) {
				const hit = await cache.match(request);
				if (hit) return hit;
				throw err;
			}
		})()
	);
});
