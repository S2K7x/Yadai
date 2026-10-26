/**
 * Delivering a Web Push message: subscriptions in, HTTP POST out.
 *
 * The encryption itself is in `push-crypto.ts` (pure, RFC-vector tested); this
 * module owns the parts that need configuration and the database — which
 * devices exist, what a failure means, and when a device has to be forgotten.
 */

import { createHash } from 'node:crypto';
import {
	VAPID_PRIVATE_KEY,
	VAPID_PUBLIC_KEY,
	VAPID_SUBJECT,
	pushConfigured
} from './config';
import {
	deletePushSubscription,
	listPushSubscriptions,
	markPushDelivered,
	markPushFailed,
	type PushSubscriptionRow
} from './db';
import { encryptPayload, vapidAuthorization } from './push-crypto';
import { encodePushMessage, endpointHost, type PushDevice, type PushMessage } from '$lib/push';

/** Stable, non-reversible handle for an endpoint. Safe to show in the UI. */
export const deviceId = (endpoint: string): string =>
	createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

/** The device list the settings panel renders — never the endpoint itself. */
export function listDevices(): PushDevice[] {
	return listPushSubscriptions().map((row) => ({
		id: deviceId(row.endpoint),
		label: row.label || 'Device',
		host: endpointHost(row.endpoint),
		created_at: row.created_at,
		last_ok_at: row.last_ok_at,
		last_error: row.last_error
	}));
}

export function findByDeviceId(id: string): PushSubscriptionRow | null {
	return listPushSubscriptions().find((row) => deviceId(row.endpoint) === id) ?? null;
}

export interface DeliveryResult {
	sent: number;
	failed: number;
	/** Endpoints the push service said are gone; already deleted. */
	dropped: number;
}

/** A push POST should not be allowed to hold a turn's tail end open. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Send one message to every subscribed device.
 *
 * Never throws: a notification is a courtesy on top of a turn that already
 * succeeded, so a dead push service must not surface as a failed turn. It does
 * prune, though — 404 and 410 mean the subscription is permanently gone
 * (Safari revokes one as soon as a push fails to show a notification), and
 * keeping it would mean retrying forever.
 */
export async function pushToAll(message: PushMessage): Promise<DeliveryResult> {
	const result: DeliveryResult = { sent: 0, failed: 0, dropped: 0 };
	if (!pushConfigured()) return result;

	const payload = encodePushMessage(message);
	const subscriptions = listPushSubscriptions();
	const outcomes = await Promise.all(
		subscriptions.map((row) => deliver(row, payload).catch(() => 'failed' as const))
	);
	for (const outcome of outcomes) {
		if (outcome === 'sent') result.sent++;
		else if (outcome === 'dropped') result.dropped++;
		else result.failed++;
	}
	return result;
}

/** Send to a single known device (the "notification de test" button). */
export async function pushToDevice(
	row: PushSubscriptionRow,
	message: PushMessage
): Promise<'sent' | 'dropped' | 'failed'> {
	if (!pushConfigured()) return 'failed';
	return deliver(row, encodePushMessage(message)).catch(() => 'failed' as const);
}

async function deliver(
	row: PushSubscriptionRow,
	payload: string
): Promise<'sent' | 'dropped' | 'failed'> {
	let body: Buffer;
	let authorization: string;
	try {
		body = encryptPayload(payload, { p256dh: row.p256dh, auth: row.auth });
		authorization = vapidAuthorization({
			endpoint: row.endpoint,
			subject: VAPID_SUBJECT,
			publicKey: VAPID_PUBLIC_KEY,
			privateKey: VAPID_PRIVATE_KEY
		});
	} catch (err) {
		// A malformed row can never be delivered — drop it rather than fail on
		// it at the end of every turn.
		deletePushSubscription(row.endpoint);
		void err;
		return 'dropped';
	}

	let response: Response;
	try {
		response = await fetch(row.endpoint, {
			method: 'POST',
			headers: {
				Authorization: authorization,
				'Content-Encoding': 'aes128gcm',
				'Content-Type': 'application/octet-stream',
				TTL: '86400',
				Urgency: 'high'
			},
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
		});
	} catch (err) {
		markPushFailed(row.endpoint, err instanceof Error ? err.message : String(err));
		return 'failed';
	}

	// Always drain: an unread body keeps the connection in undici's pool.
	const text = await response.text().catch(() => '');

	if (response.ok) {
		markPushDelivered(row.endpoint);
		return 'sent';
	}
	if (response.status === 404 || response.status === 410) {
		deletePushSubscription(row.endpoint);
		return 'dropped';
	}
	// Anything else (429, 5xx, a rejected payload) stays: the endpoint may well
	// work next time, and the reason is worth showing in the panel.
	markPushFailed(row.endpoint, `HTTP ${response.status} ${text}`.trim());
	return 'failed';
}
