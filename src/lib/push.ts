/**
 * Web Push helpers shared by the browser, the proxy and the service worker.
 *
 * Pure on purpose: the encryption lives in `src/lib/server/push-crypto.ts` and
 * never leaves the server, while everything here (payload shaping, labels,
 * capability rules) is the same on both sides and is unit-tested.
 */

/**
 * Budget for the JSON payload of one push message.
 *
 * The push services guarantee 4096 octets for the *encrypted* body, and
 * RFC 8291 framing costs 86 bytes of header + 1 padding delimiter + 16 bytes
 * of GCM tag on top of the plaintext. 3000 leaves a wide margin and is still
 * far more than a notification can display.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 3000;

/** Characters of the answer kept in the notification body. */
export const NOTIFICATION_BODY_CHARS = 180;

/** What the service worker receives and renders. */
export interface PushMessage {
	title: string;
	body: string;
	/** Local path to open on click — the `?s=` deep link. */
	url: string;
	/** Collapse key: a newer notification replaces the previous one. */
	tag: string;
}

/** One subscribed device, as the settings panel sees it. */
export interface PushDevice {
	id: string;
	label: string;
	/** Push service host (`web.push.apple.com`, …), never the full endpoint. */
	host: string;
	created_at: number;
	last_ok_at: number | null;
	last_error: string | null;
}

/** Collapse whitespace and cut to `max` characters on a word boundary. */
export function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Readable one-liner from an agent answer.
 *
 * The text is markdown and often opens with a heading or a fenced block;
 * neither reads well in a notification, so fenced code is replaced by a
 * marker and the usual leading syntax is stripped.
 */
export function answerPreview(text: string): string {
	const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, ' [code] ');
	const plain = withoutCode
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/[*_`>]/g, '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
	return truncate(plain, NOTIFICATION_BODY_CHARS);
}

/**
 * The notification for a finished turn.
 *
 * `tag` is per conversation so that two turns in the same discussion collapse
 * into one line on the lock screen instead of stacking.
 */
export function turnNotification(input: {
	sessionId: string;
	sessionTitle?: string | null;
	text?: string | null;
	error?: string | null;
}): PushMessage {
	const title = truncate(input.sessionTitle?.trim() || 'Yadai', 60);
	let body: string;
	if (input.error) body = truncate(`The turn failed: ${input.error}`, NOTIFICATION_BODY_CHARS);
	else if (input.text?.trim()) body = answerPreview(input.text);
	else body = 'Answer ready.';
	return {
		title,
		body,
		url: `/?s=${encodeURIComponent(input.sessionId)}`,
		tag: `session:${input.sessionId}`
	};
}

/**
 * Serialise a message so it fits the payload budget, shortening the body
 * rather than letting the push service reject the whole thing.
 */
export function encodePushMessage(message: PushMessage): string {
	let candidate = { ...message };
	let json = JSON.stringify(candidate);
	// UTF-8 length, not character count: French accents cost two bytes.
	while (new TextEncoder().encode(json).length > MAX_PUSH_PAYLOAD_BYTES && candidate.body) {
		const shorter = Math.floor(candidate.body.length / 2);
		candidate = { ...candidate, body: shorter > 8 ? `${candidate.body.slice(0, shorter)}…` : '' };
		json = JSON.stringify(candidate);
	}
	return json;
}

/** Push service host, for showing which service a device is registered with. */
export function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return '';
	}
}

/** Human name of a push service, from its host. */
export function pushServiceName(host: string): string {
	if (host.endsWith('push.apple.com')) return 'Apple';
	if (host.endsWith('googleapis.com') || host.endsWith('google.com')) return 'Google';
	if (host.endsWith('mozilla.com') || host.endsWith('mozaws.net')) return 'Mozilla';
	if (host.endsWith('notify.windows.com')) return 'Microsoft';
	return host || 'inconnu';
}

/** Short device name derived from the user agent, so the list is readable. */
export function deviceLabel(userAgent: string): string {
	const ua = userAgent || '';
	let platform = 'Device';
	if (/iPhone/i.test(ua)) platform = 'iPhone';
	else if (/iPad/i.test(ua)) platform = 'iPad';
	else if (/Android/i.test(ua)) platform = 'Android';
	else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'Mac';
	else if (/Windows/i.test(ua)) platform = 'Windows';
	else if (/Linux/i.test(ua)) platform = 'Linux';

	let browser = '';
	if (/Edg\//i.test(ua)) browser = 'Edge';
	else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
	else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
	else if (/CriOS|Chrome/i.test(ua)) browser = 'Chrome';
	else if (/Safari/i.test(ua)) browser = 'Safari';

	return browser ? `${platform} · ${browser}` : platform;
}

/**
 * Does this browser need "Ajouter à l'écran d'accueil" before it can subscribe?
 *
 * Safari on iOS/iPadOS only exposes Web Push to a PWA installed on the home
 * screen (iOS 16.4+); in a normal tab `pushManager.subscribe` throws. Showing a
 * button that cannot work is worse than explaining the one missing step.
 */
export function needsHomeScreenInstall(userAgent: string, standalone: boolean): boolean {
	if (standalone) return false;
	return /iPhone|iPad|iPod/i.test(userAgent || '');
}

/**
 * VAPID public key (base64url) → the Uint8Array `pushManager.subscribe` wants.
 *
 * `applicationServerKey` accepts a string in some browsers but not in Safari,
 * so the conversion is not optional.
 */
// The explicit `<ArrayBuffer>` matters: `applicationServerKey` only accepts a
// view backed by a plain ArrayBuffer, and a bare `Uint8Array` widens to
// `ArrayBufferLike` (which includes SharedArrayBuffer).
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
