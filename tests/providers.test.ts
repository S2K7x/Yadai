import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	UNGROUPED_PROVIDER_LABEL,
	accountSummary,
	advanceOauthFlow,
	beginOauthFlow,
	filterProviderGroups,
	flowKind,
	groupProviderKeys,
	isConnected,
	isEnvKeyName,
	isFlowSettled,
	isGroupConfigured,
	parseExpiry,
	secondsLeft,
	settleOauthFlow,
	shouldPollOauth,
	validationBlocks,
	validationMessage,
	type EnvVarMap,
	type OauthProvider
} from '../src/lib/providers.ts';

// ---------------------------------------------------------------------------
// Grouping API keys
// ---------------------------------------------------------------------------

function envRow(over: Record<string, unknown> = {}) {
	return {
		is_set: false,
		redacted_value: null,
		description: '',
		url: null,
		category: 'provider',
		is_password: true,
		provider: 'p',
		provider_label: 'P',
		...over
	};
}

const SAMPLE: EnvVarMap = {
	OPENROUTER_API_KEY: envRow({
		is_set: true,
		redacted_value: 'sk-o...60c6',
		provider: 'openrouter',
		provider_label: 'OpenRouter',
		description: 'OpenRouter API key',
		url: 'https://openrouter.ai/keys'
	}),
	XAI_API_KEY: envRow({ provider: 'xai', provider_label: 'xAI' }),
	// Same provider, two accepted variable names.
	GEMINI_API_KEY: envRow({ provider: 'gemini', provider_label: 'Google AI Studio' }),
	GOOGLE_API_KEY: envRow({ provider: 'gemini', provider_label: 'Google AI Studio' }),
	// Not a credential: a base-URL override on a provider row.
	XAI_BASE_URL: envRow({ provider: 'xai', provider_label: 'xAI', is_password: false }),
	// Not a provider at all.
	TELEGRAM_BOT_TOKEN: envRow({ category: 'channel', provider: '', provider_label: '' }),
	// A provider credential the catalog does not attach to a provider.
	MYSTERY_API_KEY: envRow({ provider: '', provider_label: '' })
};

test('groupProviderKeys keeps only secret provider credentials', () => {
	const groups = groupProviderKeys(SAMPLE);
	const keys = groups.flatMap((g) => g.keys.map((k) => k.key));
	assert.ok(!keys.includes('XAI_BASE_URL'), 'base URLs are configuration, not credentials');
	assert.ok(!keys.includes('TELEGRAM_BOT_TOKEN'), 'non-provider categories are excluded');
	assert.deepEqual(
		[...keys].sort(),
		['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MYSTERY_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY']
	);
});

test('groupProviderKeys folds several variables into one provider', () => {
	const gemini = groupProviderKeys(SAMPLE).find((g) => g.provider === 'gemini');
	assert.ok(gemini);
	assert.equal(gemini.label, 'Google AI Studio');
	assert.deepEqual(
		gemini.keys.map((k) => k.key),
		['GEMINI_API_KEY', 'GOOGLE_API_KEY']
	);
});

test('groupProviderKeys puts configured providers first', () => {
	const groups = groupProviderKeys(SAMPLE);
	assert.equal(groups[0].provider, 'openrouter');
	assert.ok(isGroupConfigured(groups[0]));
	assert.ok(groups.slice(1).every((g) => !isGroupConfigured(g)));
});

test('groupProviderKeys carries the redacted value and never a clear one', () => {
	const openrouter = groupProviderKeys(SAMPLE)[0];
	assert.deepEqual(openrouter.keys[0], {
		key: 'OPENROUTER_API_KEY',
		description: 'OpenRouter API key',
		url: 'https://openrouter.ai/keys',
		isSet: true,
		redacted: 'sk-o...60c6'
	});
});

test('groupProviderKeys labels an unattached credential', () => {
	const orphan = groupProviderKeys(SAMPLE).find((g) => g.provider === '');
	assert.equal(orphan?.label, UNGROUPED_PROVIDER_LABEL);
});

test('groupProviderKeys tolerates an empty answer', () => {
	assert.deepEqual(groupProviderKeys({}), []);
});

test('filterProviderGroups matches a provider label or a variable', () => {
	const groups = groupProviderKeys(SAMPLE);
	assert.equal(filterProviderGroups(groups, '').length, groups.length);

	const byLabel = filterProviderGroups(groups, 'google');
	assert.equal(byLabel.length, 1);
	assert.equal(byLabel[0].keys.length, 2, 'a provider match keeps all its variables');

	const byVar = filterProviderGroups(groups, 'GOOGLE_API');
	assert.equal(byVar.length, 1);
	assert.deepEqual(
		byVar[0].keys.map((k) => k.key),
		['GOOGLE_API_KEY'],
		'a variable match narrows to that variable'
	);

	assert.deepEqual(filterProviderGroups(groups, 'nothing-here'), []);
});

// ---------------------------------------------------------------------------
// Env var names
// ---------------------------------------------------------------------------

test('isEnvKeyName accepts real credential names and refuses junk', () => {
	for (const ok of ['OPENROUTER_API_KEY', 'HF_TOKEN', 'GH_TOKEN', 'Z_AI_API_KEY']) {
		assert.equal(isEnvKeyName(ok), true, ok);
	}
	for (const bad of ['', 'lowercase', '_LEADING', '1START', 'WITH-DASH', 'WITH SPACE', 42, null]) {
		assert.equal(isEnvKeyName(bad as unknown), false, String(bad));
	}
	assert.equal(isEnvKeyName('A'.repeat(65)), false, 'length is capped');
});

// ---------------------------------------------------------------------------
// Validation verdicts
// ---------------------------------------------------------------------------

test('only a provider that answered and rejected the key blocks a save', () => {
	assert.equal(validationBlocks({ ok: false, reachable: true }), true);
	assert.equal(validationBlocks({ ok: false, reachable: false }), false, 'offline must not block');
	assert.equal(validationBlocks({ ok: true, reachable: false }), false, 'unprobeable is not bad');
	assert.equal(validationBlocks({ ok: true, reachable: true }), false);
	assert.equal(validationBlocks(null), false);
});

test('validationMessage explains each verdict', () => {
	assert.match(validationMessage({ ok: true, reachable: true }), /accepted/);
	assert.match(validationMessage({ ok: true, reachable: false }), /cannot be checked/);
	assert.match(validationMessage({ ok: false, reachable: false }), /Could not reach/);
	assert.equal(
		validationMessage({ ok: false, reachable: true, message: 'Clé refusée.' }),
		'Clé refusée.'
	);
	assert.equal(validationMessage(null), '');
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const NOUS: OauthProvider = {
	id: 'nous',
	name: 'Nous Portal',
	flow: 'device_code',
	status: { logged_in: false }
};

const CLAUDE_CODE: OauthProvider = {
	id: 'claude-code',
	name: 'Anthropic OAuth',
	flow: 'external',
	disconnectable: false,
	status: { logged_in: true, source_label: '~/.claude/.credentials.json' }
};

test('flowKind maps upstream flows, defaulting unknown ones to external', () => {
	assert.equal(flowKind(NOUS), 'device_code');
	assert.equal(flowKind({ ...NOUS, flow: 'pkce' }), 'pkce');
	assert.equal(flowKind(CLAUDE_CODE), 'external');
	assert.equal(flowKind({ ...NOUS, flow: 'something-new' }), 'external');
});

test('accountSummary names where the credentials live once connected', () => {
	assert.equal(isConnected(CLAUDE_CODE), true);
	assert.equal(accountSummary(CLAUDE_CODE), 'Credentials: ~/.claude/.credentials.json');
	assert.match(accountSummary({ ...CLAUDE_CODE, status: { logged_in: true } }), /managed by Yadai/);
});

test('accountSummary describes the login method rather than repeating the pill', () => {
	assert.equal(isConnected(NOUS), false);
	assert.match(accountSummary(NOUS), /pairing code/);
	assert.match(accountSummary({ ...NOUS, flow: 'pkce' }), /through the web/);
	assert.match(accountSummary({ ...CLAUDE_CODE, status: { logged_in: false } }), /own CLI/);
});

test('parseExpiry normalises seconds, milliseconds and ISO strings', () => {
	assert.equal(parseExpiry(1786333053644), 1786333053644, 'already milliseconds');
	assert.equal(parseExpiry(1786333053), 1786333053000, 'seconds are scaled up');
	assert.equal(parseExpiry('2026-08-10T00:00:00Z'), Date.parse('2026-08-10T00:00:00Z'));
	assert.equal(parseExpiry(null), null);
	assert.equal(parseExpiry(undefined), null);
	assert.equal(parseExpiry(''), null);
	assert.equal(parseExpiry('not a date'), null);
	assert.equal(parseExpiry(0), null);
});

// ---------------------------------------------------------------------------
// OAuth flow state machine
// ---------------------------------------------------------------------------

const T0 = 1_760_000_000_000;

function started(over: Record<string, unknown> = {}) {
	return beginOauthFlow(
		NOUS,
		{
			session_id: 'sess-1',
			flow: 'device_code',
			user_code: 'ABCD-EFGH',
			verification_url: 'https://portal.example/device?code=ABCD-EFGH',
			expires_in: 600,
			poll_interval: 5,
			...over
		},
		T0
	);
}

test('beginOauthFlow captures the code, the deadline and the interval', () => {
	const flow = started();
	assert.equal(flow.providerId, 'nous');
	assert.equal(flow.kind, 'device_code');
	assert.equal(flow.phase, 'awaiting');
	assert.equal(flow.userCode, 'ABCD-EFGH');
	assert.equal(flow.expiresAt, T0 + 600_000);
	assert.equal(flow.pollIntervalMs, 5000);
	assert.equal(secondsLeft(flow, T0), 600);
});

test('beginOauthFlow clamps a hostile poll interval and falls back on a missing TTL', () => {
	assert.equal(started({ poll_interval: 0 }).pollIntervalMs, 2000, 'never poll faster than 2 s');
	assert.equal(started({ poll_interval: 3600 }).pollIntervalMs, 30_000, 'nor slower than 30 s');
	assert.equal(started({ poll_interval: undefined }).pollIntervalMs, 5000);
	assert.equal(started({ expires_in: undefined }).expiresAt, T0 + 900_000);
	assert.equal(started({ expires_in: -5 }).expiresAt, T0 + 900_000);
});

test('beginOauthFlow recognises a PKCE start', () => {
	const flow = beginOauthFlow(
		{ ...NOUS, id: 'anthropic', name: 'Anthropic', flow: 'pkce' },
		{ session_id: 's', flow: 'pkce', auth_url: 'https://claude.ai/oauth', expires_in: 600 },
		T0
	);
	assert.equal(flow.kind, 'pkce');
	assert.equal(flow.authUrl, 'https://claude.ai/oauth');
	assert.equal(flow.userCode, '');
});

test('shouldPollOauth polls device-code flows only, and only before the deadline', () => {
	const flow = started();
	assert.equal(shouldPollOauth(flow, T0), true);
	assert.equal(shouldPollOauth(flow, T0 + 599_000), true);
	assert.equal(shouldPollOauth(flow, T0 + 600_000), false, 'stops at the deadline');
	assert.equal(shouldPollOauth({ ...flow, kind: 'pkce' }, T0), false);
	assert.equal(shouldPollOauth({ ...flow, sessionId: '' }, T0), false);
	assert.equal(shouldPollOauth({ ...flow, phase: 'approved' }, T0), false);
	assert.equal(shouldPollOauth(null, T0), false);
});

test('advanceOauthFlow resolves each upstream status', () => {
	const flow = started();
	assert.equal(advanceOauthFlow(flow, { status: 'approved' }, T0).phase, 'approved');
	assert.equal(advanceOauthFlow(flow, { status: 'denied' }, T0).phase, 'denied');
	assert.equal(advanceOauthFlow(flow, { status: 'expired' }, T0).phase, 'expired');
	assert.equal(advanceOauthFlow(flow, { status: 'error' }, T0).phase, 'error');
});

test('advanceOauthFlow surfaces the upstream error message', () => {
	const flow = started();
	const failed = advanceOauthFlow(flow, { status: 'error', error_message: 'boom' }, T0);
	assert.equal(failed.message, 'boom');
	const blank = advanceOauthFlow(flow, { status: 'error', error_message: '  ' }, T0);
	assert.match(blank.message, /failed/);
});

test('advanceOauthFlow leaves a pending flow alone until it expires', () => {
	const flow = started();
	assert.equal(advanceOauthFlow(flow, { status: 'pending' }, T0 + 1000), flow, 'same object');
	const late = advanceOauthFlow(flow, { status: 'pending' }, T0 + 600_000);
	assert.equal(late.phase, 'expired');
});

test('advanceOauthFlow honours a shorter deadline pushed by the worker', () => {
	const flow = started();
	const tightened = advanceOauthFlow(
		flow,
		{ status: 'pending', expires_at: (T0 + 60_000) / 1000 },
		T0
	);
	assert.equal(tightened.expiresAt, T0 + 60_000);
	assert.equal(tightened.phase, 'awaiting');
	assert.equal(shouldPollOauth(tightened, T0 + 61_000), false);
});

test('advanceOauthFlow never reopens a settled flow', () => {
	const settled = settleOauthFlow(started(), 'error', 'réseau coupé');
	assert.equal(isFlowSettled(settled), true);
	assert.equal(advanceOauthFlow(settled, { status: 'approved' }, T0), settled);
	assert.equal(settleOauthFlow(settled, 'approved', 'trop tard'), settled);
});

test('isFlowSettled and secondsLeft behave at the edges', () => {
	assert.equal(isFlowSettled(null), false);
	assert.equal(isFlowSettled(started()), false);
	assert.equal(secondsLeft(started(), T0 + 10_000_000), 0, 'never negative');
});
