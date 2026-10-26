import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	MAX_INLINE_CHARS,
	MAX_TEXT_FILE_BYTES,
	displayName,
	fenceFor,
	fenceLanguage,
	inlineTextFile,
	looksBinary,
	refusalMessage
} from '../src/lib/attach.ts';

const NUL = String.fromCharCode(0);
const FFFD = '\ufffd';

test('looksBinary refuses NUL bytes and accepts ordinary prose', () => {
	assert.equal(looksBinary(`abc${NUL}def`), true);
	assert.equal(looksBinary('Élément déjà là.\n\tTabulé.\r\nCRLF.'), false);
	assert.equal(looksBinary(''), false);
	// Emoji and accents are not controls.
	assert.equal(looksBinary('héllo 🌍 — ça va ?'), false);
});

test('looksBinary refuses a decode full of replacement characters', () => {
	assert.equal(looksBinary(FFFD.repeat(40) + 'x'.repeat(60)), true);
	// One stray replacement character in a long file is not a binary.
	assert.equal(looksBinary('x'.repeat(500) + FFFD), false);
});

test('looksBinary only samples the head, so a huge file stays cheap', () => {
	// Clean head, dirty tail beyond the sample: judged on the head.
	assert.equal(looksBinary('x'.repeat(5000) + NUL), false);
});

test('fenceLanguage maps extensions, whole names, and admits ignorance', () => {
	assert.equal(fenceLanguage('app.py'), 'python');
	assert.equal(fenceLanguage('App.TS'), 'typescript');
	assert.equal(fenceLanguage('/home/pi/notes.md'), 'markdown');
	assert.equal(fenceLanguage('C:\\tmp\\config.YAML'), 'yaml');
	assert.equal(fenceLanguage('Makefile'), 'makefile');
	assert.equal(fenceLanguage('.env'), 'ini');
	assert.equal(fenceLanguage('compose.yml'), 'yaml');
	// Unknown means no tag, never a guess.
	assert.equal(fenceLanguage('archive.xyz'), '');
	assert.equal(fenceLanguage('LICENSE'), '');
	assert.equal(fenceLanguage('gateway.log'), '');
	assert.equal(fenceLanguage('Dockerfile'), '');
});

test('fenceFor is always longer than the fences inside the content', () => {
	assert.equal(fenceFor('rien de spécial'), '```');
	assert.equal(fenceFor('avant\n```js\ncode\n```\naprès'), '````');
	assert.equal(fenceFor('````\nx\n````'), '`````');
	// An inline span is not a fence.
	assert.equal(fenceFor('appelle `ls` puis `pwd`'), '```');
	// Indented fences count too — they still close a block.
	assert.equal(fenceFor('  ```\nx\n  ```'), '````');
});

test('displayName keeps the basename and strips what would break the header', () => {
	assert.equal(displayName('/var/log/gateway.log'), 'gateway.log');
	assert.equal(displayName('C:\\Users\\moi\\notes.txt'), 'notes.txt');
	assert.equal(displayName(`bizarre\nnom.txt`), 'bizarrenom.txt');
	assert.equal(displayName('« citation ».txt'), 'citation .txt');
	assert.equal(displayName(''), 'fichier');
	assert.equal(displayName('/'), 'fichier');
	assert.equal(displayName(`${'a'.repeat(200)}.txt`).length, 120);
});

test('inlineTextFile builds a header, a tagged fence and the body', () => {
	const result = inlineTextFile('config.yaml', 'model: opus\n');
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.block, 'File "config.yaml":\n\n```yaml\nmodel: opus\n```');
	assert.equal(result.chars, 'model: opus'.length);
});

test('inlineTextFile survives a file that itself contains a fence', () => {
	const result = inlineTextFile('notes.md', 'Voici :\n\n```sh\nls -la\n```\n');
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.ok(result.block.startsWith('File "notes.md":\n\n````markdown\n'));
	assert.ok(result.block.endsWith('\n````'));
	// The inner fence is still intact inside the block.
	assert.ok(result.block.includes('```sh\nls -la\n```'));
});

test('inlineTextFile normalises CRLF and trailing blank lines', () => {
	const result = inlineTextFile('a.txt', 'une\r\ndeux\r\n\r\n\r\n');
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.block, 'File "a.txt":\n\n```\nune\ndeux\n```');
});

test('inlineTextFile refuses rather than truncating or lying', () => {
	assert.deepEqual(inlineTextFile('vide.txt', '   \n\n'), { ok: false, reason: 'empty' });
	assert.deepEqual(inlineTextFile('photo.jpg', `\u00ff\u00d8${NUL}${NUL}${NUL}`), {
		ok: false,
		reason: 'binary'
	});
	assert.deepEqual(inlineTextFile('gros.txt', 'x'.repeat(MAX_INLINE_CHARS + 1)), {
		ok: false,
		reason: 'too-large'
	});
	// Exactly at the limit still goes through.
	assert.equal(inlineTextFile('pile.txt', 'x'.repeat(MAX_INLINE_CHARS)).ok, true);
});

test('refusalMessage names the file and says the number that matters', () => {
	assert.match(refusalMessage('vide.txt', 'empty'), /"vide\.txt" skipped: the file is empty\./);
	assert.match(refusalMessage('/tmp/photo.jpg', 'binary'), /"photo\.jpg".+images/);
	assert.match(refusalMessage('gros.txt', 'too-large', 70_000), /70,000 characters/);
	assert.match(refusalMessage('gros.txt', 'too-large', 70_000), /60,000 that can be inserted/);
});

test('the two gates stay ordered: bytes are a looser bound than characters', () => {
	assert.ok(MAX_TEXT_FILE_BYTES > MAX_INLINE_CHARS);
});
