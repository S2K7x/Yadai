/**
 * The Pi's own vital signs, as the dashboard reports them.
 *
 * `GET /api/system/stats` (`hermes_cli/web_server.py`) answers with the host's
 * CPU, load average, memory and uptime — read-only, no credential, no path
 * beyond the Hermes home. It is the question the welcome screen suggests
 * asking the agent ("Quel est l'état du Raspberry Pi ?"), which until now cost
 * a full turn and a `terminal` call to answer.
 *
 * Everything below is pure so it can be tested without a browser, and every
 * field is optional: upstream degrades gracefully when `psutil` is missing
 * (`psutil: false`), in which case only the load average survives. A row is
 * built when its numbers are there and left out otherwise — never guessed.
 */

import { formatBytes, formatNumber } from './format.ts';

/** The payload of `GET /api/system/stats`, with the fields this app reads. */
export interface SystemStats {
	hostname?: string;
	arch?: string;
	cpu_count?: number | null;
	python_version?: string;
	hermes_version?: string;
	cpu_percent?: number;
	load_avg?: number[];
	memory?: { total?: number; available?: number; used?: number; percent?: number };
	uptime_seconds?: number;
	psutil?: boolean;
}

/** Same three levels the status panel already paints as a coloured dot. */
export type SystemLevel = 'ok' | 'warn' | 'ko';

export interface SystemRow {
	key: 'cpu' | 'load' | 'memory' | 'uptime';
	label: string;
	value: string;
	/** Second half of the line, when the number needs a scale to mean anything. */
	detail: string;
	level: SystemLevel;
}

/**
 * How long the machine has been up, in one phrase.
 *
 * Coarse on purpose: "22 jours" is the whole of what an uptime says. Minutes
 * only matter in the first hour — which is exactly when it says "the Pi
 * rebooted", the one thing worth noticing.
 */
export function humanizeUptime(seconds: number | undefined | null): string {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.floor(seconds);
	if (s < 60) return "moins d'une minute";
	const minutes = Math.floor(s / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(s / 3600);
	if (hours < 24) {
		const rest = minutes - hours * 60;
		return rest > 0 ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
	}
	const days = Math.floor(s / 86400);
	return days === 1 ? '1 jour' : `${days} jours`;
}

const level = (value: number, warn: number, ko: number): SystemLevel =>
	value >= ko ? 'ko' : value >= warn ? 'warn' : 'ok';

/**
 * The rows to draw, in reading order.
 *
 * Disk is deliberately absent: the gateway's own readiness check already
 * reports it in the same panel, and the same number twice reads as two
 * different measurements.
 */
export function systemRows(stats: SystemStats | null | undefined): SystemRow[] {
	if (!stats) return [];
	const rows: SystemRow[] = [];
	const cores = typeof stats.cpu_count === 'number' && stats.cpu_count > 0 ? stats.cpu_count : 0;

	if (typeof stats.cpu_percent === 'number' && Number.isFinite(stats.cpu_percent)) {
		rows.push({
			key: 'cpu',
			label: 'Processeur',
			value: `${Math.round(stats.cpu_percent)} %`,
			detail: cores ? `${cores} cœurs` : '',
			level: level(stats.cpu_percent, 70, 90)
		});
	}

	const load = (stats.load_avg ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n));
	if (load.length > 0) {
		// Per core is the only reading that means anything: 3.5 is idle on a
		// 16-core server and a queue on this Pi's four.
		const perCore = cores ? load[0] / cores : load[0];
		rows.push({
			key: 'load',
			label: 'Charge',
			value: load.slice(0, 3).map((n) => formatNumber(n)).join(' · '),
			detail: cores ? `${Math.round(perCore * 100)} % de ${cores} cœurs` : '',
			level: level(perCore, 0.7, 1.2)
		});
	}

	const mem = stats.memory;
	if (mem && typeof mem.total === 'number' && mem.total > 0) {
		const used = typeof mem.used === 'number' ? mem.used : undefined;
		const percent =
			typeof mem.percent === 'number' ? mem.percent : used !== undefined ? (used / mem.total) * 100 : 0;
		rows.push({
			key: 'memory',
			label: 'Mémoire',
			value: `${formatBytes(used)} / ${formatBytes(mem.total)}`,
			detail: `${Math.round(percent)} % utilisée`,
			level: level(percent, 80, 92)
		});
	}

	if (typeof stats.uptime_seconds === 'number') {
		rows.push({
			key: 'uptime',
			label: 'Allumé depuis',
			value: humanizeUptime(stats.uptime_seconds),
			detail: '',
			// An uptime is never a problem in itself.
			level: 'ok'
		});
	}

	return rows;
}

/** Which machine this is, as one discreet line under the section title. */
export function machineLine(stats: SystemStats | null | undefined): string {
	if (!stats) return '';
	const parts = [
		stats.hostname,
		stats.arch,
		typeof stats.cpu_count === 'number' && stats.cpu_count > 0 ? `${stats.cpu_count} cœurs` : null,
		stats.python_version ? `Python ${stats.python_version}` : null
	].filter((p): p is string => typeof p === 'string' && p.length > 0);
	return parts.join(' · ');
}
