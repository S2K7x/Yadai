/**
 * Dropping a text file into the composer — pure logic, no DOM.
 *
 * Hermes accepts images and nothing else: `file`, `input_file`, `file_id` and
 * non-image `data:` URLs all come back as 400 `unsupported_content_type` (see
 * CLAUDE.md point 5). So a log, a config or a snippet had no way in at all —
 * the composer refused it with an explanation and the user was left to open
 * the file elsewhere and paste it by hand.
 *
 * Pasting it by hand is exactly what this does, minus the hand: the file is
 * read in the browser and **inlined into the message** as a fenced block with
 * its name above it. Nothing new is asked of the API — what leaves the browser
 * is the same plain prompt it has always accepted.
 *
 * Two rules the rest of the module exists to keep:
 *
 * - **Nothing is ever truncated.** A file too big to inline is refused, with
 *   its size said out loud. A block that arrived half-quoted would be answered
 *   half-quoted, and nothing on screen would say so — the same reasoning as
 *   `MAX_DRAFT_CHARS` in `$lib/drafts`.
 * - **The fence is longer than anything inside it.** A markdown file quoting
 *   ``` would otherwise close the block early, and the tail of the file would
 *   land in the prompt as prose.
 */

/**
 * Read gate, applied to the file's byte size before anything is decoded.
 *
 * Generous compared to `MAX_INLINE_CHARS` on purpose: UTF-8 French prose runs
 * well over one byte per character, and the useful refusal is the one about
 * the decoded text, not about the encoding.
 */
export const MAX_TEXT_FILE_BYTES = 512 * 1024;

/**
 * Inline gate, applied to the decoded text.
 *
 * 60k characters is roughly fifteen thousand tokens — already a large share of
 * any context window, and about as much as a textarea can hold while staying
 * scrollable. `MAX_DRAFT_CHARS` (100k) is the next ceiling above this one: two
 * such files in one message still work, they simply stop being saved as a
 * draft.
 */
export const MAX_INLINE_CHARS = 60_000;

/** How many characters of the decoded text `looksBinary` inspects. */
const BINARY_SAMPLE = 4096;

/**
 * Whether decoded text came from something that was never text.
 *
 * `File.text()` decodes as UTF-8 whatever the bytes were, so a JPEG comes back
 * as a string — full of NULs and U+FFFD replacement characters. Refusing on
 * the decoded shape rather than on the extension is what lets `Dockerfile`,
 * `.env.example` and `Makefile` through without an allowlist to maintain.
 */
export function looksBinary(text: string): boolean {
	const sample = text.slice(0, BINARY_SAMPLE);
	if (sample.includes('\u0000')) return true;
	if (!sample.length) return false;
	let bad = 0;
	for (const ch of sample) {
		const code = ch.codePointAt(0)!;
		// C0 controls other than tab / newline / carriage return, plus the
		// replacement character a failed UTF-8 decode leaves behind.
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || ch === '\ufffd') bad++;
	}
	return bad / sample.length > 0.02;
}

/**
 * Extension → highlight.js language tag.
 *
 * Only tags that `highlight.js/lib/common` actually registers (point 9): an
 * unknown one makes the library log "did you forget to load the language
 * module?" on every render, and highlights nothing anyway. Unknown extension
 * means no tag, never a guess — `toml` and `.env` borrow `ini` because that
 * grammar reads them correctly, `csv` and `Dockerfile` get nothing.
 */
const LANGUAGES: Record<string, string> = {
	bash: 'bash',
	c: 'c',
	cc: 'cpp',
	cfg: 'ini',
	conf: 'ini',
	cpp: 'cpp',
	cs: 'csharp',
	css: 'css',
	csv: '',
	diff: 'diff',
	env: 'ini',
	go: 'go',
	h: 'c',
	hpp: 'cpp',
	htm: 'html',
	html: 'html',
	ini: 'ini',
	java: 'java',
	js: 'javascript',
	json: 'json',
	jsx: 'javascript',
	kt: 'kotlin',
	log: '',
	lua: 'lua',
	md: 'markdown',
	mjs: 'javascript',
	patch: 'diff',
	php: 'php',
	pl: 'perl',
	properties: 'ini',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	scss: 'scss',
	sh: 'bash',
	sql: 'sql',
	svelte: 'xml',
	swift: 'swift',
	toml: 'ini',
	ts: 'typescript',
	tsx: 'typescript',
	txt: '',
	xml: 'xml',
	yaml: 'yaml',
	yml: 'yaml',
	zsh: 'bash'
};

/** Files whose whole name is the type. */
const BY_NAME: Record<string, string> = {
	dockerfile: '',
	makefile: 'makefile',
	gemfile: 'ruby',
	rakefile: 'ruby',
	'.env': 'ini',
	'.gitignore': ''
};

/** The fence's language tag for a file name, or '' when nothing is known. */
export function fenceLanguage(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	const lower = base.toLowerCase();
	if (lower in BY_NAME) return BY_NAME[lower];
	const dot = lower.lastIndexOf('.');
	if (dot <= 0) return '';
	return LANGUAGES[lower.slice(dot + 1)] ?? '';
}

/**
 * A fence at least three backticks long, and always longer than the longest
 * run of backticks the content opens a line with.
 */
export function fenceFor(content: string): string {
	let longest = 0;
	for (const match of content.matchAll(/^\s*(`{3,})/gm)) {
		longest = Math.max(longest, match[1].length);
	}
	return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The file name as it will be printed above the block.
 *
 * Names come from the user's own device, but they still reach a markdown
 * renderer via the transcript: a newline in one would split the header line
 * away from its block, and a « » of its own would blur where the name ends.
 */
export function displayName(name: string): string {
	const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f«»]/g, '').trim();
	if (!base) return 'fichier';
	return base.length > 120 ? `${base.slice(0, 119)}…` : base;
}

export type InlineRefusal = 'too-large' | 'binary' | 'empty';

export type InlineResult =
	| { ok: true; block: string; chars: number }
	| { ok: false; reason: InlineRefusal };

/**
 * Turn a decoded text file into the markdown block to append to the message,
 * or say why it cannot be one.
 *
 * The header is plain text rather than an inline code span: a name containing
 * a backtick would otherwise need escaping rules of its own.
 */
export function inlineTextFile(name: string, content: string): InlineResult {
	if (!content.trim()) return { ok: false, reason: 'empty' };
	if (looksBinary(content)) return { ok: false, reason: 'binary' };
	if (content.length > MAX_INLINE_CHARS) return { ok: false, reason: 'too-large' };

	// Normalise line endings so a CRLF file does not print a stray ^M at every
	// line once it goes through the markdown renderer.
	const body = content.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
	const fence = fenceFor(body);
	const block = `File "${displayName(name)}":\n\n${fence}${fenceLanguage(name)}\n${body}\n${fence}`;
	return { ok: true, block, chars: body.length };
}

/** Why a file was refused, said to the user with the numbers that matter. */
export function refusalMessage(name: string, reason: InlineRefusal, chars = 0): string {
	const quoted = `"${displayName(name)}"`;
	if (reason === 'empty') return `${quoted} skipped: the file is empty.`;
	if (reason === 'binary')
		return `${quoted} skipped: it is not a text file. Only images are accepted as attachments.`;
	const k = Math.round(chars / 1000);
	const max = Math.round(MAX_INLINE_CHARS / 1000);
	return `${quoted} skipped: ${k > 0 ? `${k},000 characters, ` : ''}beyond the ${max},000 that can be inserted at once.`;
}
