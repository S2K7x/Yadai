import type { RequestHandler } from './$types';
import { getHealthDetailed, listJobs } from '$lib/server/hermes';
import { DashboardError, DashboardErrorCode, getSystemStats } from '$lib/server/dashboard';
import { currentTurns, turnLimit } from '$lib/server/limits';
import { proxy } from '$lib/server/respond';

/**
 * Why the host's numbers are missing, in words that fit the section they
 * replace. The shared `dashboard_disabled` message talks about provider
 * credentials — true of the panel it was written for, misleading under a
 * heading about the Raspberry Pi.
 */
function systemMessage(reason: unknown): string {
	if (reason instanceof DashboardError && reason.code === DashboardErrorCode.Disabled) {
		return "HERMES_DASHBOARD_TOKEN is not configured: the machine's counters cannot be read.";
	}
	return String((reason as { message?: string })?.message ?? reason);
}

/**
 * Rich status for the diagnostics panel: Hermes readiness checks (state.db,
 * model, disk, platforms, background queues) plus this app's own turn counter.
 *
 * The host's vital signs come from the third upstream, the dashboard: CPU,
 * load, memory and uptime, which the gateway does not report. Until now that
 * was a question one asked the agent — a full turn and a `terminal` call for
 * four numbers that are one read away.
 *
 * Failures degrade instead of 502ing the whole panel — a missing cron module
 * should not hide the disk warning next to it, and an unconfigured dashboard
 * must not hide the readiness checks.
 */
export const GET: RequestHandler = () =>
	proxy(async () => {
		const [health, jobs, system] = await Promise.allSettled([
			getHealthDetailed(),
			listJobs(),
			getSystemStats()
		]);
		return {
			health: health.status === 'fulfilled' ? health.value : null,
			healthError: health.status === 'rejected' ? String(health.reason?.message ?? health.reason) : null,
			jobs: jobs.status === 'fulfilled' ? (jobs.value.jobs ?? []) : [],
			jobsAvailable: jobs.status === 'fulfilled',
			// A nicety: when it is missing the section is simply absent, and the
			// reason is kept so the panel can say it in one muted line rather
			// than pretend the Pi has nothing to report.
			system: system.status === 'fulfilled' ? system.value : null,
			systemError: system.status === 'rejected' ? systemMessage(system.reason) : null,
			turns: { active: currentTurns(), limit: turnLimit() }
		};
	});
