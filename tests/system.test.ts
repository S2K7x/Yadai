import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeUptime, machineLine, systemRows, type SystemStats } from '../src/lib/system.ts';

/**
 * The host's vital signs, as `GET /api/system/stats` reports them.
 *
 * The fixture below is the real payload measured on this Pi, trimmed to the
 * fields the app reads — 4 cores, 8 GB of RAM, 22 days of uptime.
 */
const REAL: SystemStats = {
	hostname: 'pi',
	arch: 'aarch64',
	cpu_count: 4,
	python_version: '3.11.15',
	hermes_version: '0.20.0',
	cpu_percent: 18.6,
	load_avg: [0.291015625, 0.17236328125, 0.111328125],
	memory: { total: 8454012928, available: 5535039488, used: 2918973440, percent: 34.5 },
	uptime_seconds: 1934360,
	psutil: true
};

// The byte and number formatters moved to `$lib/format`: see tests/format.test.ts.

test('an uptime is coarse, except in the first hour', () => {
	assert.equal(humanizeUptime(30), "moins d'une minute");
	assert.equal(humanizeUptime(90), '1 min');
	assert.equal(humanizeUptime(59 * 60), '59 min');
	assert.equal(humanizeUptime(3600), '1 h');
	assert.equal(humanizeUptime(3600 + 12 * 60), '1 h 12');
	assert.equal(humanizeUptime(5 * 3600 + 5 * 60), '5 h 05');
	assert.equal(humanizeUptime(86400), '1 jour');
	assert.equal(humanizeUptime(1934360), '22 jours');
	assert.equal(humanizeUptime(undefined), '—');
	assert.equal(humanizeUptime(-5), '—');
});

test('the four rows of a healthy Pi', () => {
	const rows = systemRows(REAL);
	assert.deepEqual(
		rows.map((r) => r.key),
		['cpu', 'load', 'memory', 'uptime']
	);
	const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
	assert.equal(byKey.cpu.value, '19 %');
	assert.equal(byKey.cpu.detail, '4 cœurs');
	assert.equal(byKey.load.value, '0,29 · 0,17 · 0,11');
	assert.equal(byKey.memory.value, '2,7 Go / 7,9 Go');
	assert.equal(byKey.memory.detail, '35 % utilisée');
	assert.equal(byKey.uptime.value, '22 jours');
	for (const row of rows) assert.equal(row.level, 'ok');
});

/**
 * The load average is read per core, which is the only reading that means
 * anything: 3.5 is idle on a sixteen-core server and a queue on this Pi's four.
 */
test('the load level is relative to the number of cores', () => {
	const load = (n: number, cores = 4) =>
		systemRows({ load_avg: [n, n, n], cpu_count: cores }).find((r) => r.key === 'load');
	assert.equal(load(1)?.level, 'ok');
	assert.equal(load(3)?.level, 'warn');
	assert.equal(load(6)?.level, 'ko');
	// The same figure on a bigger machine is nothing at all.
	assert.equal(load(6, 16)?.level, 'ok');
	assert.equal(load(2)?.detail, '50 % de 4 cœurs');
});

test('CPU and memory turn colour at their own thresholds', () => {
	const cpu = (n: number) => systemRows({ cpu_percent: n }).find((r) => r.key === 'cpu')?.level;
	assert.equal(cpu(10), 'ok');
	assert.equal(cpu(75), 'warn');
	assert.equal(cpu(95), 'ko');

	const mem = (percent: number) =>
		systemRows({ memory: { total: 1000, used: 10 * percent, percent } }).find(
			(r) => r.key === 'memory'
		)?.level;
	assert.equal(mem(34.5), 'ok');
	assert.equal(mem(85), 'warn');
	assert.equal(mem(95), 'ko');
});

/**
 * Upstream degrades when `psutil` is missing — only the load average survives,
 * from the standard library. A row whose numbers are absent is left out rather
 * than drawn with a zero, which would read as a measurement.
 */
test('a field that is missing draws no row', () => {
	const degraded = systemRows({ psutil: false, load_avg: [0.5, 0.4, 0.3], cpu_count: 4 });
	assert.deepEqual(
		degraded.map((r) => r.key),
		['load']
	);
	assert.deepEqual(systemRows({}), []);
	assert.deepEqual(systemRows(null), []);
	assert.deepEqual(systemRows(undefined), []);
	// A memory block without a total is not a measurement either.
	assert.deepEqual(systemRows({ memory: { percent: 40 } }), []);
	// Nor is a load average of non-numbers.
	assert.deepEqual(
		systemRows({ load_avg: [Number.NaN] as number[] }).map((r) => r.key),
		[]
	);
});

test('memory falls back to computing the percentage itself', () => {
	const row = systemRows({ memory: { total: 2000, used: 500 } }).find((r) => r.key === 'memory');
	assert.equal(row?.detail, '25 % utilisée');
});

test('the machine line names the host, and skips what it does not know', () => {
	assert.equal(machineLine(REAL), 'pi · aarch64 · 4 cœurs · Python 3.11.15');
	assert.equal(machineLine({ hostname: 'pi' }), 'pi');
	assert.equal(machineLine({}), '');
	assert.equal(machineLine(null), '');
});
