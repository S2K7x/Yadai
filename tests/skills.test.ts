import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DESCRIPTION_FILE,
	MAX_NAME_LENGTH,
	SKILL_FILE,
	categoryTemplate,
	groupSkillFiles,
	isEditableFile,
	isValidSkillName,
	skillKey,
	skillSegments,
	skillTemplate,
	slugifySkillName,
	utf8Length,
	type SkillFileEntry
} from '../src/lib/skills.ts';

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

test('isValidSkillName accepts the shapes Hermes uses on disk', () => {
	for (const name of ['apple', 'smart-home', 'autonomous-ai-agents', 'x', 'gpt5', '0-day']) {
		assert.equal(isValidSkillName(name), true, name);
	}
});

test('isValidSkillName rejects anything that could leave the skills tree', () => {
	for (const name of [
		'',
		'.',
		'..',
		'.curator_state',
		'.bundled_manifest',
		'-leading-dash',
		'Upper',
		'with space',
		'with_underscore',
		'a/b',
		'a\\b',
		'../etc',
		'a\0b',
		'é',
		'a'.repeat(MAX_NAME_LENGTH + 1)
	]) {
		assert.equal(isValidSkillName(name), false, JSON.stringify(name));
	}
	assert.equal(isValidSkillName(undefined), false);
	assert.equal(isValidSkillName(42), false);
});

test('isEditableFile allows only the two documented filenames', () => {
	assert.equal(isEditableFile(SKILL_FILE), true);
	assert.equal(isEditableFile(DESCRIPTION_FILE), true);
	for (const file of ['skill.md', 'README.md', 'SKILL.md.bak', '../SKILL.md', '', null]) {
		assert.equal(isEditableFile(file), false, String(file));
	}
});

// ---------------------------------------------------------------------------
// Path building — the security-critical part
// ---------------------------------------------------------------------------

test('skillSegments builds the documented layout', () => {
	assert.deepEqual(skillSegments({ category: 'apple', skill: 'findmy', file: SKILL_FILE }), [
		'apple',
		'findmy',
		SKILL_FILE
	]);
	assert.deepEqual(skillSegments({ category: 'apple', skill: null, file: DESCRIPTION_FILE }), [
		'apple',
		DESCRIPTION_FILE
	]);
	// An omitted `skill` means the same thing as an explicit null.
	assert.deepEqual(skillSegments({ category: 'apple', file: DESCRIPTION_FILE }), [
		'apple',
		DESCRIPTION_FILE
	]);
});

test('skillSegments refuses traversal in every position', () => {
	const bad = [
		{ category: '..', skill: 'findmy', file: SKILL_FILE },
		{ category: 'apple', skill: '..', file: SKILL_FILE },
		{ category: 'apple/..', skill: 'findmy', file: SKILL_FILE },
		{ category: '/etc', skill: 'passwd', file: SKILL_FILE },
		{ category: 'apple', skill: '../../../.hermes', file: SKILL_FILE },
		{ category: '.hermes', skill: 'x', file: SKILL_FILE }
	] as const;
	for (const ref of bad) {
		assert.equal(skillSegments(ref as never), null, JSON.stringify(ref));
	}
});

test('skillSegments refuses a filename outside the allowlist', () => {
	assert.equal(skillSegments({ category: 'apple', skill: 'findmy', file: '.env' as never }), null);
	assert.equal(
		skillSegments({ category: 'apple', skill: 'findmy', file: 'scripts/run.sh' as never }),
		null
	);
});

test('skillSegments keeps each filename at its own level', () => {
	// DESCRIPTION.md belongs to a category, never to a skill…
	assert.equal(
		skillSegments({ category: 'apple', skill: 'findmy', file: DESCRIPTION_FILE }),
		null
	);
	// …and SKILL.md to a skill, never straight under a category.
	assert.equal(skillSegments({ category: 'apple', skill: null, file: SKILL_FILE }), null);
});

// ---------------------------------------------------------------------------
// Slug + templates
// ---------------------------------------------------------------------------

test('slugifySkillName produces a name the validator accepts', () => {
	assert.equal(slugifySkillName('Ma Veille Tech'), 'ma-veille-tech');
	assert.equal(slugifySkillName("Résumé d'articles"), 'resume-d-articles');
	assert.equal(slugifySkillName('  --Trim--  '), 'trim');
	assert.equal(slugifySkillName('a/b/c'), 'a-b-c');
	assert.equal(slugifySkillName('!!!'), '');
	assert.equal(isValidSkillName(slugifySkillName('Ma Veille Tech')), true);
});

test('slugifySkillName never returns an over-long or trailing-dash name', () => {
	const slug = slugifySkillName('x '.repeat(80));
	assert.ok(slug.length <= MAX_NAME_LENGTH);
	assert.equal(slug.endsWith('-'), false);
	assert.equal(isValidSkillName(slug), true);
});

test('skillTemplate emits parsable frontmatter with the skill name', () => {
	const text = skillTemplate('ma-veille-tech', 'Quand je demande ma veille.');
	assert.ok(text.startsWith('---\n'));
	assert.match(text, /^name: ma-veille-tech$/m);
	assert.match(text, /^description: Quand je demande ma veille\.$/m);
	// Hermes' parser looks for a closing fence on its own line.
	assert.match(text, /\n---\s*\n/);
});

test('categoryTemplate is non-empty markdown', () => {
	assert.match(categoryTemplate('productivity'), /^# productivity$/m);
});

// ---------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------

const entry = (category: string, skill: string | null): SkillFileEntry => ({
	category,
	skill,
	file: skill ? SKILL_FILE : DESCRIPTION_FILE,
	size: 100,
	modified: 1_700_000_000
});

test('groupSkillFiles groups, sorts and separates the category description', () => {
	const groups = groupSkillFiles([
		entry('smart-home', 'lights'),
		entry('apple', 'findmy'),
		entry('apple', null),
		entry('apple', 'imessage')
	]);
	assert.deepEqual(
		groups.map((g) => g.category),
		['apple', 'smart-home']
	);
	assert.equal(groups[0].description?.file, DESCRIPTION_FILE);
	assert.deepEqual(
		groups[0].skills.map((s) => s.skill),
		['findmy', 'imessage']
	);
});

test('groupSkillFiles filters on both category and skill names', () => {
	const entries = [entry('apple', null), entry('apple', 'findmy'), entry('smart-home', 'lights')];

	// A category match keeps the whole category.
	const byCategory = groupSkillFiles(entries, 'APP');
	assert.deepEqual(
		byCategory.map((g) => g.category),
		['apple']
	);
	assert.equal(byCategory[0].skills.length, 1);

	// A skill match keeps only the matching rows, but still shows the category.
	const bySkill = groupSkillFiles(entries, 'light');
	assert.deepEqual(
		bySkill.map((g) => g.category),
		['smart-home']
	);
	assert.deepEqual(
		bySkill[0].skills.map((s) => s.skill),
		['lights']
	);

	assert.deepEqual(groupSkillFiles(entries, 'zzz'), []);
});

test('skillKey distinguishes a category description from a skill', () => {
	assert.notEqual(skillKey(entry('apple', null)), skillKey(entry('apple', 'findmy')));
	assert.equal(skillKey(entry('apple', 'findmy')), skillKey(entry('apple', 'findmy')));
});

test('utf8Length counts bytes, not code units', () => {
	assert.equal(utf8Length('abc'), 3);
	assert.equal(utf8Length('é'), 2);
	assert.equal(utf8Length('🙂'), 4);
});

// `formatBytes` moved to `$lib/format`, which the status panel already used:
// see tests/format.test.ts.
