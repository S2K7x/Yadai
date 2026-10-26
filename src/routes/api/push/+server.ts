import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { VAPID_PUBLIC_KEY, pushConfigured } from '$lib/server/config';
import { deletePushSubscription, savePushSubscription } from '$lib/server/db';
import { deviceId, findByDeviceId, listDevices } from '$lib/server/push';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { deviceLabel } from '$lib/push';

/**
 * Subscription registry for Web Push.
 *
 * `GET` also carries the VAPID public key: `pushManager.subscribe` needs it as
 * `applicationServerKey`, and publishing it is its purpose — it is the identity
 * the push service will check later signatures against, not a secret. The
 * private key never appears in any response.
 *
 * Endpoints do not leave the server either. An endpoint URL is a bearer
 * capability for that device, so devices are identified in the UI by a digest
 * of it (`deviceId`) and shown with their push service host only.
 */
export const GET: RequestHandler = async () => {
	return json({
		available: pushConfigured(),
		publicKey: pushConfigured() ? VAPID_PUBLIC_KEY : '',
		devices: pushConfigured() ? listDevices() : []
	});
};

interface SubscribeBody {
	endpoint?: unknown;
	keys?: { p256dh?: unknown; auth?: unknown };
	label?: unknown;
}

/** Register (or refresh) this browser's subscription. Idempotent. */
export const POST: RequestHandler = async ({ request }) => {
	const limited = gate('push-write', 1, 10);
	if (limited) return limited;
	if (!pushConfigured()) {
		return errorResponse(
			503,
			"Notifications are not configured on the server (VAPID keys missing).",
			'push_unavailable'
		);
	}

	const parsed = await readJson<SubscribeBody>(request);
	if ('response' in parsed) return parsed.response;
	const { endpoint, keys, label } = parsed.body;

	if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) {
		return errorResponse(400, 'Invalid subscription endpoint.', 'invalid_body');
	}
	if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
		return errorResponse(400, 'The subscription does not carry its keys.', 'invalid_body');
	}

	savePushSubscription({
		endpoint,
		p256dh: keys.p256dh,
		auth: keys.auth,
		label:
			typeof label === 'string' && label.trim()
				? label.trim().slice(0, 60)
				: deviceLabel(request.headers.get('user-agent') ?? '')
	});

	return json({ id: deviceId(endpoint), devices: listDevices() });
};

/** Forget a device, by its own endpoint or by the id shown in the panel. */
export const DELETE: RequestHandler = async ({ request, url }) => {
	const limited = gate('push-write', 1, 10);
	if (limited) return limited;

	const id = url.searchParams.get('id');
	let endpoint: string | null = null;

	if (id) {
		endpoint = findByDeviceId(id)?.endpoint ?? null;
	} else {
		const parsed = await readJson<{ endpoint?: unknown }>(request);
		if ('response' in parsed) return parsed.response;
		if (typeof parsed.body.endpoint === 'string') endpoint = parsed.body.endpoint;
	}

	// A device the server has already dropped (410 from the push service) is
	// not an error to report — the caller wanted it gone and it is gone.
	if (endpoint) deletePushSubscription(endpoint);
	return json({ ok: true, devices: listDevices() });
};
