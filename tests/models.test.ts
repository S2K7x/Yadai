import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isModelAvailable,
	modelEntries,
	pickModels,
	priceDetail,
	priceLabel,
	providerForModel,
	shortModelName
} from '../src/lib/models.ts';
import type { ModelOptions } from '../src/lib/types.ts';

const provider = (over: Partial<ModelOptions['providers'][number]>): ModelOptions['providers'][number] => ({
	slug: over.slug ?? 'p',
	name: over.name ?? 'Provider',
	is_current: over.is_current ?? false,
	authenticated: over.authenticated ?? true,
	models: over.models ?? [],
	total_models: over.models?.length ?? 0,
	warning: over.warning,
	pricing: over.pricing,
	unavailable_models: over.unavailable_models
});

const options = (providers: ModelOptions['providers']): ModelOptions => ({
	model: providers[0]?.models[0] ?? '',
	provider: providers[0]?.slug ?? '',
	providers
});

test('shortModelName keeps the last path segment', () => {
	assert.equal(shortModelName('openrouter/deepseek/free'), 'free');
	assert.equal(shortModelName('gpt-5'), 'gpt-5');
	assert.equal(shortModelName(''), '');
});

test('providerForModel finds the provider offering the model', () => {
	const opts = options([
		provider({ slug: 'openai', models: ['gpt-5'] }),
		provider({ slug: 'ollama', models: ['qwen3'] })
	]);
	assert.equal(providerForModel(opts, 'qwen3'), 'ollama');
});

test('providerForModel prefers the provider already in use on a tie', () => {
	const opts = options([
		provider({ slug: 'openrouter', models: ['qwen3'] }),
		provider({ slug: 'ollama', models: ['qwen3'], is_current: true })
	]);
	assert.equal(providerForModel(opts, 'qwen3'), 'ollama');
});

test('providerForModel ignores providers without credentials', () => {
	const opts = options([
		provider({ slug: 'anthropic', models: ['claude'], authenticated: false }),
		provider({ slug: 'openai', models: ['gpt-5'] })
	]);
	assert.equal(providerForModel(opts, 'claude'), '');
});

test('providerForModel is empty rather than wrong when nothing is known', () => {
	assert.equal(providerForModel(null, 'gpt-5'), '');
	assert.equal(providerForModel(options([provider({ models: ['gpt-5'] })]), ''), '');
	assert.equal(providerForModel(options([]), 'gpt-5'), '');
});

test('isModelAvailable tracks authenticated providers only', () => {
	const opts = options([
		provider({ slug: 'openai', models: ['gpt-5'] }),
		provider({ slug: 'anthropic', models: ['claude'], authenticated: false })
	]);
	assert.equal(isModelAvailable(opts, 'gpt-5'), true);
	assert.equal(isModelAvailable(opts, 'claude'), false);
	assert.equal(isModelAvailable(null, 'gpt-5'), false);
});

// --- the picker list -------------------------------------------------------

test('modelEntries keeps only what a turn could run on', () => {
	const opts = options([
		provider({ slug: 'openrouter', name: 'OpenRouter', models: ['a', 'b'] }),
		provider({ slug: 'gemini', name: 'Gemini', models: ['g'], authenticated: false }),
		provider({ slug: 'empty', name: 'Empty', models: [] })
	]);
	assert.deepEqual(
		modelEntries(opts).map((e) => `${e.provider}/${e.model}`),
		['openrouter/a', 'openrouter/b']
	);
	assert.deepEqual(modelEntries(null), []);
});

test('modelEntries attaches the price and drops what the tier cannot pick', () => {
	const opts = options([
		provider({
			slug: 'nous',
			name: 'Nous',
			models: ['free-one', 'paid-one'],
			pricing: {
				'free-one': { input: 'free', output: 'free', cache: null, free: true },
				'paid-one': { input: '$3.00', output: '$15.00', cache: '$0.30', free: false }
			},
			unavailable_models: ['paid-one']
		})
	]);
	const entries = modelEntries(opts);
	assert.deepEqual(
		entries.map((e) => e.model),
		['free-one']
	);
	assert.equal(entries[0].free, true);
});

test('modelEntries leaves the price null when the provider has no catalogue', () => {
	const entries = modelEntries(options([provider({ slug: 'anthropic', models: ['claude'] })]));
	assert.equal(entries[0].price, null);
	assert.equal(entries[0].free, false);
});

test('priceLabel reads the formatted figures, and never guesses', () => {
	assert.equal(priceLabel({ input: '$2.00', output: '$10.00', free: false }), '$2.00 / $10.00 per Mtok');
	assert.equal(priceLabel({ input: 'free', output: 'free', free: true }), 'Free');
	assert.equal(priceLabel({ input: '$2.00', output: '', free: false }), '$2.00 per Mtok');
	// No figure at all must read as "unknown", not as "free".
	assert.equal(priceLabel({ input: '', output: '', free: false }), null);
	assert.equal(priceLabel(null), null);
	assert.equal(priceLabel(undefined), null);
});

test('priceDetail spells out the three figures for the tooltip', () => {
	assert.equal(
		priceDetail({ input: '$2.00', output: '$10.00', cache: '$0.20', free: false }),
		'Input $2.00 · Output $10.00 · Cache $0.20, per million tokens'
	);
	assert.equal(priceDetail({ input: 'free', output: 'free', free: true }), 'Free, per million tokens');
	assert.equal(priceDetail({ cache: null, free: false }), null);
	assert.equal(priceDetail(null), null);
});

test('pickModels matches the provider as well as the model id', () => {
	const opts = options([
		provider({ slug: 'copilot', name: 'GitHub Copilot', models: ['gpt-5'] }),
		provider({ slug: 'openrouter', name: 'OpenRouter', models: ['qwen3'] })
	]);
	const entries = modelEntries(opts);
	assert.deepEqual(
		pickModels(entries, 'copilot', 50).shown.map((e) => e.model),
		['gpt-5']
	);
	assert.deepEqual(
		pickModels(entries, 'GitHub', 50).shown.map((e) => e.model),
		['gpt-5']
	);
	assert.deepEqual(
		pickModels(entries, 'qwen', 50).shown.map((e) => e.model),
		['qwen3']
	);
	assert.equal(pickModels(entries, '  ', 50).shown.length, 2);
});

test('pickModels reports what the cap hid instead of dropping it silently', () => {
	const entries = modelEntries(
		options([provider({ models: Array.from({ length: 80 }, (_, i) => `m${i}`) })])
	);
	const page = pickModels(entries, '', 60);
	assert.equal(page.shown.length, 60);
	assert.equal(page.hidden, 20);
	// Under the cap nothing is hidden, and a filter narrows before the cap.
	assert.equal(pickModels(entries, '', 100).hidden, 0);
	assert.equal(pickModels(entries, 'm7', 60).hidden, 0);
});
