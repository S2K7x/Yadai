import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_PUSH_PAYLOAD_BYTES,
	NOTIFICATION_BODY_CHARS,
	answerPreview,
	base64UrlToBytes,
	deviceLabel,
	encodePushMessage,
	endpointHost,
	needsHomeScreenInstall,
	pushServiceName,
	truncate,
	turnNotification
} from '../src/lib/push.ts';

test('truncate collapses whitespace and cuts on a word boundary', () => {
	assert.equal(truncate('  deux   mots ', 40), 'deux mots');
	assert.equal(truncate('abcdef ghijkl mnopqr', 14), 'abcdef ghijkl…');
	// No usable space near the end: cut mid-word rather than losing everything.
	assert.equal(truncate('abcdefghijklmnopqrst', 8), 'abcdefgh…');
});

test('answerPreview strips markdown noise', () => {
	assert.equal(answerPreview('## Titre\nUn **résultat** clair.'), 'Titre Un résultat clair.');
	assert.equal(
		answerPreview('Voici :\n```sh\nls -la\n```\nfini.'),
		'Voici : [code] fini.'
	);
	assert.equal(answerPreview('Voir [la doc](https://x.invalid/y).'), 'Voir la doc.');
	// An unterminated fence (a truncated answer) must not swallow nothing.
	assert.equal(answerPreview('Avant\n```js\nconst a = 1'), 'Avant [code]');
});

test('answerPreview respects the body budget', () => {
	const preview = answerPreview('mot '.repeat(500));
	assert.ok(preview.length <= NOTIFICATION_BODY_CHARS + 1, preview.length.toString());
});

test('turnNotification carries the deep link and a per-session tag', () => {
	const message = turnNotification({
		sessionId: 'abc 123',
		sessionTitle: 'Veille technique',
		text: 'Trois nouveautés aujourd’hui.'
	});
	assert.equal(message.title, 'Veille technique');
	assert.equal(message.body, 'Trois nouveautés aujourd’hui.');
	assert.equal(message.url, '/?s=abc%20123');
	assert.equal(message.tag, 'session:abc 123');
});

test('turnNotification falls back when the turn has no text or title', () => {
	assert.deepEqual(turnNotification({ sessionId: 's1', text: '   ' }), {
		title: 'Yadai',
		body: 'Answer ready.',
		url: '/?s=s1',
		tag: 'session:s1'
	});
});

test('turnNotification reports a failed turn', () => {
	const message = turnNotification({ sessionId: 's1', error: 'Modèle indisponible', text: 'x' });
	assert.equal(message.body, 'The turn failed: Modèle indisponible');
});

test('encodePushMessage stays inside the payload budget', () => {
	const message = {
		title: 'Titre',
		// Accented characters cost two UTF-8 bytes each: character count alone
		// would let this through.
		body: 'é'.repeat(4000),
		url: '/?s=x',
		tag: 'session:x'
	};
	const json = encodePushMessage(message);
	assert.ok(new TextEncoder().encode(json).length <= MAX_PUSH_PAYLOAD_BYTES);
	const parsed = JSON.parse(json);
	assert.equal(parsed.title, 'Titre');
	assert.equal(parsed.url, '/?s=x');
	assert.ok(parsed.body.length > 0);
});

test('encodePushMessage leaves a small message untouched', () => {
	const message = { title: 'Yadai', body: 'court', url: '/', tag: 't' };
	assert.deepEqual(JSON.parse(encodePushMessage(message)), message);
});

test('endpointHost and pushServiceName name the push service', () => {
	assert.equal(endpointHost('https://web.push.apple.com/abc?x=1'), 'web.push.apple.com');
	assert.equal(endpointHost('pas une url'), '');
	assert.equal(pushServiceName('web.push.apple.com'), 'Apple');
	assert.equal(pushServiceName('fcm.googleapis.com'), 'Google');
	assert.equal(pushServiceName('updates.push.services.mozilla.com'), 'Mozilla');
	assert.equal(pushServiceName(''), 'inconnu');
});

test('deviceLabel names the platform and the browser', () => {
	assert.equal(
		deviceLabel(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
		),
		'iPhone · Safari'
	);
	assert.equal(
		deviceLabel(
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
		),
		'Linux · Chrome'
	);
	assert.equal(deviceLabel(''), 'Device');
});

test('needsHomeScreenInstall only fires for an iOS tab', () => {
	const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1';
	assert.equal(needsHomeScreenInstall(iphone, false), true);
	assert.equal(needsHomeScreenInstall(iphone, true), false);
	assert.equal(needsHomeScreenInstall('Mozilla/5.0 (Macintosh) Safari/605', false), false);
});

test('base64UrlToBytes decodes a VAPID public key', () => {
	const key =
		'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
	const bytes = base64UrlToBytes(key);
	assert.equal(bytes.length, 65);
	assert.equal(bytes[0], 0x04);
	assert.equal(Buffer.from(bytes).toString('base64url'), key);
});
