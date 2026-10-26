import assert from 'node:assert/strict';
import test from 'node:test';
import {
	JOB_TEMPLATES,
	MAX_JOB_NAME,
	MAX_JOB_PROMPT,
	canEditJob,
	composeJobPrompt,
	humanCron,
	humanMinutes,
	jobInstructionLimit,
	jobState,
	lastRunLabel,
	nextRunLabel,
	parseDuration,
	parseSchedule,
	scheduleDisplay,
	scheduleExpression,
	scheduleFromSpec,
	sortJobs,
	specFromExpression,
	targetLabel,
	usableTargets
} from '../src/lib/jobs.ts';
import type { HermesJob } from '../src/lib/types.ts';

// A fixed clock so "in 30 min" never depends on when the suite runs.
const NOW = new Date(2026, 7, 10, 9, 0, 0); // 10 August 2026, 09:00 local

// ---------------------------------------------------------------------------
// parseDuration — mirrors cron/jobs.py::parse_duration
// ---------------------------------------------------------------------------

test('parseDuration accepts every unit spelling upstream accepts', () => {
	assert.equal(parseDuration('30m'), 30);
	assert.equal(parseDuration('30 minutes'), 30);
	assert.equal(parseDuration('2h'), 120);
	assert.equal(parseDuration('2 hours'), 120);
	assert.equal(parseDuration('1d'), 1440);
	assert.equal(parseDuration(' 3 DAYS '), 4320);
});

test('parseDuration rejects what upstream rejects', () => {
	assert.equal(parseDuration('soon'), null);
	assert.equal(parseDuration('30'), null);
	assert.equal(parseDuration('m30'), null);
	assert.equal(parseDuration('1.5h'), null);
	assert.equal(parseDuration('-2h'), null);
	// A zero duration parses upstream but would schedule nothing useful.
	assert.equal(parseDuration('0m'), null);
});

test('humanMinutes keeps round values readable', () => {
	assert.equal(humanMinutes(30), '30 min');
	assert.equal(humanMinutes(120), '2 hours');
	assert.equal(humanMinutes(1440), '1 day');
	assert.equal(humanMinutes(90), '1h 30m');
});

// ---------------------------------------------------------------------------
// parseSchedule — the guard rail in front of an upstream 500
// ---------------------------------------------------------------------------

test('parseSchedule classifies the four accepted forms', () => {
	assert.equal(parseSchedule('30m', NOW).kind, 'once');
	assert.equal(parseSchedule('every 30m', NOW).kind, 'interval');
	assert.equal(parseSchedule('0 9 * * *', NOW).kind, 'cron');
	assert.equal(parseSchedule('2026-12-31T23:59', NOW).kind, 'once');
});

test('parseSchedule follows the upstream precedence: "every" wins over cron', () => {
	// "every 5 * * * *" starts with "every ", so upstream never reaches the
	// cron branch — and its duration is unparseable.
	assert.equal(parseSchedule('every 5 * * * *', NOW).kind, null);
});

test('parseSchedule previews a relative one-shot against the given clock', () => {
	const parsed = parseSchedule('2h', NOW);
	assert.equal(parsed.kind, 'once');
	assert.match(parsed.display, /in 2 hours/);
	assert.equal(parsed.error, '');
});

test('parseSchedule rejects an empty or unreadable schedule', () => {
	assert.equal(parseSchedule('', NOW).kind, null);
	assert.equal(parseSchedule('   ', NOW).kind, null);
	assert.equal(parseSchedule('chaque matin', NOW).kind, null);
	assert.ok(parseSchedule('chaque matin', NOW).error.length > 0);
});

test('parseSchedule rejects out-of-range cron fields croniter would refuse', () => {
	assert.equal(parseSchedule('0 25 * * *', NOW).kind, null);
	assert.equal(parseSchedule('60 9 * * *', NOW).kind, null);
	assert.equal(parseSchedule('0 9 32 * *', NOW).kind, null);
	assert.equal(parseSchedule('0 9 * 13 *', NOW).kind, null);
	assert.equal(parseSchedule('0 9 * * 8', NOW).kind, null);
	// A descending range is not a range.
	assert.equal(parseSchedule('0 18-9 * * *', NOW).kind, null);
	// Step must be a positive integer.
	assert.equal(parseSchedule('*/0 * * * *', NOW).kind, null);
});

test('parseSchedule accepts the cron shapes croniter accepts', () => {
	assert.equal(parseSchedule('*/15 * * * *', NOW).kind, 'cron');
	assert.equal(parseSchedule('0 9-18 * * 1-5', NOW).kind, 'cron');
	assert.equal(parseSchedule('0 8,12,20 * * *', NOW).kind, 'cron');
	assert.equal(parseSchedule('0 0 1 1 0', NOW).kind, 'cron');
	// Six fields (the optional year) still reads as cron upstream.
	assert.equal(parseSchedule('0 9 * * * 2027', NOW).kind, 'cron');
});

test('parseSchedule refuses a timestamp in the past, which upstream rejects too', () => {
	assert.equal(parseSchedule('2020-01-01T09:00', NOW).kind, null);
	assert.match(parseSchedule('2020-01-01T09:00', NOW).error, /past/);
});

test('parseSchedule reads a naive timestamp as wall clock, not UTC', () => {
	// new Date("2026-08-11") would be UTC midnight; upstream reads the naive
	// form in the Hermes timezone, so the preview must stay on local time.
	const parsed = parseSchedule('2026-08-11', NOW);
	assert.equal(parsed.kind, 'once');
	assert.match(parsed.display, /11/);
});

// ---------------------------------------------------------------------------
// Reading a job back
// ---------------------------------------------------------------------------

test('scheduleDisplay never leaks the schedule object', () => {
	assert.equal(scheduleDisplay({} as HermesJob), '—');
	assert.notEqual(scheduleDisplay({ schedule: { kind: 'once' } }), '[object Object]');
	assert.notEqual(scheduleDisplay({ schedule: { kind: 'nouveau', size: 3 } }), '[object Object]');
});

test('scheduleDisplay prefers the structured fields over the English display', () => {
	// Upstream sends `schedule_display: "every 720m"` alongside these.
	assert.equal(
		scheduleDisplay({
			schedule: { kind: 'interval', minutes: 720, display: 'every 720m' },
			schedule_display: 'every 720m'
		}),
		'every 12 hours'
	);
	assert.equal(
		scheduleDisplay({ schedule: { kind: 'cron', expr: '0 9 * * *' }, schedule_display: '0 9 * * *' }),
		'every day at 09:00'
	);
	assert.match(
		scheduleDisplay({
			schedule: { kind: 'once', run_at: '2026-12-31T23:59:00+03:00' },
			schedule_display: 'once at 2026-12-31 23:59'
		}),
		/^once, on /
	);
});

test('scheduleDisplay falls back to schedule_display for shapes it cannot read', () => {
	assert.equal(scheduleDisplay({ schedule_display: 'every 60m' }), 'every 60m');
	assert.equal(scheduleDisplay({ schedule: { kind: 'interval' } as never }), 'interval');
});

test('jobState trusts the reconciled state over the enabled flag', () => {
	// effective_job_state() upstream refuses to call an enabled job paused.
	assert.equal(jobState({ state: 'scheduled', enabled: true }).key, 'scheduled');
	assert.equal(jobState({ state: 'paused', enabled: false }).key, 'paused');
	assert.equal(jobState({ state: 'error' }).key, 'error');
	assert.equal(jobState({ state: 'completed' }).key, 'completed');
	// Records written before `state` existed fall back to `enabled`.
	assert.equal(jobState({ enabled: false }).key, 'paused');
	assert.equal(jobState({}).key, 'scheduled');
});

test('nextRunLabel switches from relative to absolute past 18 hours', () => {
	const soon = new Date(NOW.getTime() + 120 * 60_000).toISOString();
	assert.match(nextRunLabel({ next_run_at: soon }, NOW), /in 2 hours/);

	const later = new Date(NOW.getTime() + 40 * 3600_000).toISOString();
	assert.doesNotMatch(nextRunLabel({ next_run_at: later }, NOW), /\bin\b/);

	assert.equal(nextRunLabel({}, NOW), '');
	assert.equal(nextRunLabel({ next_run_at: null }, NOW), '');
	assert.equal(nextRunLabel({ next_run_at: 'pas une date' }, NOW), '');
});

test('sortJobs puts runnable jobs first, soonest first, undated last', () => {
	const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
	const jobs: HermesJob[] = [
		{ id: 'c', state: 'paused', next_run_at: at(1) },
		{ id: 'b', state: 'scheduled', next_run_at: null },
		{ id: 'a', state: 'scheduled', next_run_at: at(3) },
		{ id: 'z', state: 'scheduled', next_run_at: at(1) }
	];
	assert.deepEqual(
		sortJobs(jobs).map((j) => j.id),
		['z', 'a', 'b', 'c']
	);
	// Pure: the input order is untouched.
	assert.equal(jobs[0].id, 'c');
});

// ---------------------------------------------------------------------------
// Delivery targets
// ---------------------------------------------------------------------------

test('usableTargets drops platforms with no configured home channel', () => {
	const targets = usableTargets([
		{ id: 'local', name: 'Local (save only)', home_target_set: true },
		{ id: 'telegram', name: 'Telegram', home_target_set: true },
		{ id: 'slack', name: 'Slack', home_target_set: false }
	]);
	assert.deepEqual(
		targets.map((t) => t.id),
		['local', 'telegram']
	);
});

test('targetLabel translates the local choice and passes platforms through', () => {
	// Upstream calls it "Local (save only)".
	assert.equal(targetLabel({ id: 'local', name: 'Local (save only)' }), 'Local (save only)');
	assert.equal(targetLabel({ id: 'telegram', name: 'Telegram' }), 'Telegram');
	assert.equal(targetLabel({ id: 'matrix' }), 'matrix');
});

test('usableTargets always keeps a local choice, even from an empty list', () => {
	assert.deepEqual(
		usableTargets([]).map((t) => t.id),
		['local']
	);
	assert.deepEqual(
		usableTargets([{ id: 'telegram', home_target_set: true }]).map((t) => t.id),
		['local', 'telegram']
	);
});

// ---------------------------------------------------------------------------
// Picking a schedule without writing cron
// ---------------------------------------------------------------------------

const SPEC = {
	mode: 'daily' as const,
	time: '08:30',
	weekday: 1,
	monthday: 5,
	every: 2,
	unit: 'h' as const,
	at: '2026-12-31T23:59',
	raw: '0 9 * * 1-5'
};

test('scheduleFromSpec renders every mode as an expression Hermes accepts', () => {
	const expr = (mode: (typeof SPEC)['mode'] | 'weekly' | 'monthly' | 'interval' | 'once' | 'advanced') =>
		scheduleFromSpec({ ...SPEC, mode });

	assert.equal(expr('daily'), '30 8 * * *');
	assert.equal(expr('weekly'), '30 8 * * 1');
	assert.equal(expr('monthly'), '30 8 5 * *');
	assert.equal(expr('interval'), 'every 2h');
	assert.equal(expr('once'), '2026-12-31T23:59');
	assert.equal(expr('advanced'), '0 9 * * 1-5');

	// And each one survives the parser that guards the upstream 500.
	for (const mode of ['daily', 'weekly', 'monthly', 'interval', 'once', 'advanced'] as const) {
		assert.notEqual(parseSchedule(expr(mode), NOW).kind, null, mode);
	}
});

test('scheduleFromSpec yields an empty expression for an unfinished spec', () => {
	// An empty time input, and a count the number field cannot make sense of.
	assert.equal(scheduleFromSpec({ ...SPEC, mode: 'daily', time: '' }), '');
	assert.equal(scheduleFromSpec({ ...SPEC, mode: 'interval', every: 0 }), '');
	assert.equal(parseSchedule('', NOW).kind, null);
});

test('specFromExpression reopens a job in the mode that produced it', () => {
	assert.equal(specFromExpression('30 8 * * *', NOW).mode, 'daily');
	assert.equal(specFromExpression('30 8 * * *', NOW).time, '08:30');
	assert.equal(specFromExpression('0 19 * * 5', NOW).mode, 'weekly');
	assert.equal(specFromExpression('0 19 * * 5', NOW).weekday, 5);
	assert.equal(specFromExpression('0 6 12 * *', NOW).mode, 'monthly');
	assert.equal(specFromExpression('0 6 12 * *', NOW).monthday, 12);
	// Sunday is 0 or 7 upstream; the picker only offers 0.
	assert.equal(specFromExpression('0 6 * * 7', NOW).weekday, 0);
});

test('specFromExpression folds an interval back into its largest unit', () => {
	assert.deepEqual(
		(({ mode, every, unit }) => ({ mode, every, unit }))(specFromExpression('every 90m', NOW)),
		{ mode: 'interval', every: 90, unit: 'm' }
	);
	assert.deepEqual(
		(({ every, unit }) => ({ every, unit }))(specFromExpression('every 720m', NOW)),
		{ every: 12, unit: 'h' }
	);
	assert.deepEqual(
		(({ every, unit }) => ({ every, unit }))(specFromExpression('every 2880m', NOW)),
		{ every: 2, unit: 'd' }
	);
});

test('specFromExpression keeps anything else intact in advanced mode', () => {
	for (const expr of ['0 9-18 * * 1-5', '*/15 * * * *', '0 8,12,20 * * *', 'every 5 * * * *']) {
		const spec = specFromExpression(expr, NOW);
		assert.equal(spec.mode, 'advanced', expr);
		assert.equal(spec.raw, expr);
	}
});

test('a schedule survives the round trip through the pickers', () => {
	for (const expr of ['30 8 * * *', '0 19 * * 5', '0 6 12 * *', 'every 12h', '0 9-18 * * 1-5']) {
		assert.equal(scheduleFromSpec(specFromExpression(expr, NOW)), expr, expr);
	}
});

test('humanCron names the shapes the pickers produce, and only those', () => {
	assert.equal(humanCron('30 8 * * *'), 'every day at 08:30');
	assert.equal(humanCron('0 19 * * 5'), 'every Friday at 19:00');
	assert.equal(humanCron('0 6 * * 0'), 'every Sunday at 06:00');
	assert.equal(humanCron('0 6 * * 7'), 'every Sunday at 06:00');
	assert.equal(humanCron('0 6 12 * *'), 'on day 12 of every month at 06:00');
	assert.equal(humanCron('*/15 * * * *'), 'every 15 min');
	assert.equal(humanCron('0 */6 * * *'), 'every 6 hours, at minute 0');
	// Anything it cannot name honestly comes back empty, so the caller shows
	// the expression itself.
	assert.equal(humanCron('0 9-18 * * 1-5'), '');
	assert.equal(humanCron('0 8,12,20 * * *'), '');
	assert.equal(humanCron('0 9 * * * 2027'), '');
	assert.equal(humanCron('n importe quoi'), '');
});

// ---------------------------------------------------------------------------
// Editing an existing task
// ---------------------------------------------------------------------------

test('scheduleExpression turns the stored schedule back into an expression', () => {
	assert.equal(scheduleExpression({ schedule: { kind: 'cron', expr: '0 8 * * *' } }), '0 8 * * *');
	assert.equal(scheduleExpression({ schedule: { kind: 'interval', minutes: 720 } }), 'every 720m');
	assert.equal(
		scheduleExpression({ schedule: { kind: 'once', run_at: '2026-12-31T23:59:00' } }),
		'2026-12-31T23:59:00'
	);
	assert.equal(scheduleExpression({ schedule: 'every 30m' }), 'every 30m');
	assert.equal(scheduleExpression({ schedule_display: 'every 60m' }), 'every 60m');
	assert.equal(scheduleExpression({}), '');
});

test('an editable task is one whose schedule can be sent back up', () => {
	assert.equal(canEditJob({ schedule: { kind: 'cron', expr: '0 8 * * *' } }, NOW), true);
	assert.equal(canEditJob({ schedule: { kind: 'interval', minutes: 60 } }, NOW), true);
	// A spent one-shot: re-sending its date is exactly what update_job refuses.
	assert.equal(canEditJob({ schedule: { kind: 'once', run_at: '2020-01-01T09:00:00' } }, NOW), false);
	assert.equal(canEditJob({}, NOW), false);
});

test('lastRunLabel translates the statuses upstream writes', () => {
	const at = new Date(NOW.getTime() - 3600_000).toISOString();
	assert.match(lastRunLabel({ last_run_at: at, last_status: 'ok' }), /succeeded$/);
	assert.match(lastRunLabel({ last_run_at: at, last_status: 'error' }), /failed$/);
	assert.match(lastRunLabel({ last_run_at: at, last_status: 'blocked_config' }), /blocked/);
	assert.match(lastRunLabel({ last_run_at: at, last_status: 'no_change' }), /nothing new$/);
	// An unknown status is reported as finished, not guessed at.
	assert.match(lastRunLabel({ last_run_at: at, last_status: 'martien' }), /finished$/);
	assert.equal(lastRunLabel({ last_run_at: at }).includes('·'), false);
	assert.equal(lastRunLabel({}), '');
	assert.equal(lastRunLabel({ last_run_at: 'pas une date' }), '');
});

// ---------------------------------------------------------------------------
// The agent's card, baked into the prompt
// ---------------------------------------------------------------------------

test('composeJobPrompt leaves an agent-less task exactly as typed', () => {
	const composed = composeJobPrompt('', '  Résume ma journée.  ');
	assert.equal(composed.prompt, 'Résume ma journée.');
	assert.equal(composed.personaChars, 0);
	assert.equal(composed.clipped, false);
});

test('composeJobPrompt puts the card first and the instruction last', () => {
	const composed = composeJobPrompt('Tu es Chercheur.', 'Cherche les nouveautés.');
	assert.ok(composed.prompt.startsWith('Tu es Chercheur.'));
	assert.ok(composed.prompt.endsWith('Cherche les nouveautés.'));
	assert.ok(composed.personaChars > 'Tu es Chercheur.'.length);
	assert.equal(composed.clipped, false);
});

test('composeJobPrompt never exceeds the upstream prompt cap', () => {
	const composed = composeJobPrompt('P'.repeat(6000), 'I'.repeat(1000));
	assert.equal(composed.prompt.length, MAX_JOB_PROMPT);
	assert.equal(composed.clipped, true);
	// The instruction is what must survive intact.
	assert.ok(composed.prompt.endsWith('I'.repeat(1000)));
});

test('composeJobPrompt drops the card rather than the instruction when full', () => {
	const instruction = 'I'.repeat(MAX_JOB_PROMPT);
	const composed = composeJobPrompt('Tu es Chercheur.', instruction);
	assert.equal(composed.prompt, instruction);
	assert.equal(composed.personaChars, 0);
	assert.equal(composed.clipped, true);
});

test('jobInstructionLimit reserves room for the card when there is one', () => {
	assert.equal(jobInstructionLimit(false), MAX_JOB_PROMPT);
	assert.ok(jobInstructionLimit(true) < MAX_JOB_PROMPT);
	// A card of exactly the remaining room still fits whole.
	const card = 'Tu es Chercheur.';
	const composed = composeJobPrompt(card, 'I'.repeat(jobInstructionLimit(true) - card.length));
	assert.equal(composed.prompt.length, MAX_JOB_PROMPT);
	assert.equal(composed.clipped, false);

	// At the very limit there is room for the header but none for the card, so
	// the instruction goes up alone — and the panel says so.
	const full = composeJobPrompt(card, 'I'.repeat(jobInstructionLimit(true)));
	assert.equal(full.clipped, true);
	assert.equal(full.personaChars, 0);
});

test('the ready-made tasks are usable as they stand', () => {
	for (const template of JOB_TEMPLATES) {
		assert.ok(template.name.length > 0 && template.name.length <= MAX_JOB_NAME, template.label);
		assert.ok(template.instruction.length <= jobInstructionLimit(true), template.label);
	}
});
