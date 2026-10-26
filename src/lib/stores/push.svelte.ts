import { api } from '$lib/client/api';
import { base64UrlToBytes, deviceLabel, needsHomeScreenInstall, type PushDevice } from '$lib/push';
import { toasts } from './toast.svelte';

interface PushConfig {
	available: boolean;
	publicKey: string;
	devices: PushDevice[];
}

/**
 * Web Push, from the browser's side.
 *
 * Two constraints shape everything here, both from Safari on iOS:
 *
 * - `Notification.requestPermission()` must be reached from a user gesture, so
 *   `enable()` calls it first thing and never behind an await.
 * - Web Push only exists for a PWA installed on the home screen. In a Safari
 *   tab `pushManager.subscribe` throws, so the panel explains the install step
 *   instead of offering a button that cannot work.
 */
class PushStore {
	/** Does this browser have the APIs at all? */
	supported = $state(false);
	/** Running as an installed app (`display-mode: standalone`). */
	standalone = $state(false);
	/** Server has VAPID keys configured. */
	available = $state(false);
	permission = $state<NotificationPermission>('default');
	devices = $state<PushDevice[]>([]);
	/** Digest of this browser's own endpoint, once it has one. */
	thisDeviceId = $state<string | null>(null);
	busy = $state(false);
	loaded = $state(false);

	#publicKey = '';
	#presenceBound = false;
	#started: Promise<void> | null = null;

	/** Is this very browser subscribed? */
	get enabled(): boolean {
		return this.thisDeviceId !== null;
	}

	/** Show "Ajouter à l'écran d'accueil" instead of the enable button. */
	get needsInstall(): boolean {
		return needsHomeScreenInstall(navigator.userAgent, this.standalone);
	}

	/** Idempotent: called once at boot and again whenever the panel opens. */
	init(): Promise<void> {
		this.#started ??= this.#start();
		return this.#started;
	}

	async #start(): Promise<void> {
		this.supported =
			'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
		this.standalone =
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as { standalone?: boolean }).standalone === true;
		if (this.supported) this.permission = Notification.permission;

		try {
			const config = await api<PushConfig>('/api/push');
			this.available = config.available;
			this.#publicKey = config.publicKey;
			this.devices = config.devices ?? [];
		} catch {
			this.available = false;
		}
		this.loaded = true;

		if (!this.supported || !this.available) return;

		// A subscription the browser still holds is the source of truth: if the
		// server database was reset, or this device was removed from another
		// one, re-registering it here is what "still enabled" means.
		const subscription = await this.#existingSubscription();
		if (subscription) await this.#register(subscription);
		this.#bindPresence();
	}

	/** Reload the device list (after removing one elsewhere). */
	async refresh(): Promise<void> {
		try {
			const config = await api<PushConfig>('/api/push');
			this.available = config.available;
			this.#publicKey = config.publicKey;
			this.devices = config.devices ?? [];
		} catch (err) {
			toasts.error(err);
		}
	}

	/**
	 * Subscribe this browser. MUST be called straight from a click handler.
	 */
	async enable(): Promise<void> {
		if (this.busy || !this.supported || !this.available) return;
		// First statement, no await before it: Safari only honours the prompt
		// while the user gesture is still on the stack.
		const permission = await Notification.requestPermission();
		this.permission = permission;
		if (permission !== 'granted') {
			toasts.info(
				permission === 'denied'
					? 'Notifications denied. Allow them in Safari settings for this app.'
					: 'Notifications not allowed.'
			);
			return;
		}

		this.busy = true;
		try {
			const registration = await navigator.serviceWorker.ready;
			let subscription = await registration.pushManager.getSubscription();
			// A subscription made against a previous VAPID key still exists in
			// the browser but can never be pushed to — the push service checks
			// the signature against the key it was created with. Rather than
			// leave that silently broken, drop it and make a new one.
			if (subscription && !this.#matchesKey(subscription)) {
				await subscription.unsubscribe().catch(() => false);
				subscription = null;
			}
			subscription ??= await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: base64UrlToBytes(this.#publicKey)
			});
			await this.#register(subscription);
			this.#bindPresence();
			toasts.success('Notifications turned on for this device.');
		} catch (err) {
			toasts.error(err);
		} finally {
			this.busy = false;
		}
	}

	/** Unsubscribe this browser and forget it server-side. */
	async disable(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const subscription = await this.#existingSubscription();
			if (subscription) {
				// Unsubscribe first: if the DELETE then fails, the row left
				// behind is simply pruned on the next 410 from the push
				// service. The other order would leave the browser holding a
				// subscription that `init()` faithfully re-registers.
				await subscription.unsubscribe().catch(() => false);
				await api('/api/push', {
					method: 'DELETE',
					body: JSON.stringify({ endpoint: subscription.endpoint })
				});
			}
			this.thisDeviceId = null;
			await this.refresh();
			toasts.info('Notifications turned off for this device.');
		} catch (err) {
			toasts.error(err);
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Remove a device from the list.
	 *
	 * Removing *this* one goes through `disable()`: deleting the row alone
	 * would leave the browser subscribed, and the next `init()` would put it
	 * straight back.
	 */
	async remove(id: string): Promise<void> {
		if (id === this.thisDeviceId) return this.disable();
		try {
			const res = await api<{ devices: PushDevice[] }>(
				`/api/push?id=${encodeURIComponent(id)}`,
				{ method: 'DELETE', body: JSON.stringify({}) }
			);
			this.devices = res.devices ?? [];
			if (this.thisDeviceId === id) this.thisDeviceId = null;
		} catch (err) {
			toasts.error(err);
		}
	}

	/** Ask the server to push a notification right now. */
	async test(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const res = await api<{ sent: number; failed: number; dropped: number }>(
				'/api/push/test',
				{ method: 'POST', body: JSON.stringify({}) }
			);
			if (res.sent > 0) {
				toasts.success(
					`Notification sent to ${res.sent} device${res.sent > 1 ? 's' : ''}. Lock the screen to see it.`
				);
			} else {
				toasts.push('error', 'No notification could be sent.');
			}
			await this.refresh();
		} catch (err) {
			toasts.error(err);
		} finally {
			this.busy = false;
		}
	}

	/** Was this subscription created against the VAPID key we serve today? */
	#matchesKey(subscription: PushSubscription): boolean {
		const applied = subscription.options.applicationServerKey;
		if (!applied) return true; // nothing to compare against; assume good
		const mine = base64UrlToBytes(this.#publicKey);
		const theirs = new Uint8Array(applied as ArrayBuffer);
		return (
			theirs.length === mine.length && theirs.every((byte, index) => byte === mine[index])
		);
	}

	async #existingSubscription(): Promise<PushSubscription | null> {
		if (!this.supported) return null;
		try {
			const registration = await navigator.serviceWorker.getRegistration();
			return (await registration?.pushManager.getSubscription()) ?? null;
		} catch {
			return null;
		}
	}

	async #register(subscription: PushSubscription): Promise<void> {
		const payload = subscription.toJSON();
		const res = await api<{ id: string; devices: PushDevice[] }>('/api/push', {
			method: 'POST',
			body: JSON.stringify({
				endpoint: payload.endpoint,
				keys: payload.keys,
				label: deviceLabel(navigator.userAgent)
			})
		});
		this.thisDeviceId = res.id;
		this.devices = res.devices ?? [];
	}

	/**
	 * Tell the server when the app leaves the screen.
	 *
	 * Without this, a desktop tab in the background keeps its SSE stream open
	 * and would look exactly like someone watching the answer arrive. `pagehide`
	 * covers the case iOS does not report as a visibility change.
	 */
	#bindPresence(): void {
		if (this.#presenceBound) return;
		this.#presenceBound = true;
		const send = (visible: boolean) => {
			// keepalive so the report survives the page being torn down.
			fetch('/api/push/presence', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ visible }),
				keepalive: true
			}).catch(() => undefined);
		};
		document.addEventListener('visibilitychange', () =>
			send(document.visibilityState === 'visible')
		);
		window.addEventListener('pagehide', () => send(false));
		send(document.visibilityState === 'visible');
	}
}

export const push = new PushStore();
