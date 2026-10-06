import type { RequestHandler } from './$types';
import { gate } from '$lib/server/respond';
import {
	DashboardError,
	dashboardConfigured,
	getUsageAnalytics
} from '$lib/server/dashboard';
import { emptyReport, normalizeUsage, resolvePeriod, type UsageReport } from '$lib/usage';

/**
 * What the agent consumed, from the dashboard's own accounting.
 *
 * The gateway reports usage per session row (`input_tokens`, `api_call_count`,
 * …) and this app already shows that for one conversation. What it could not
 * answer was the question across all of them — "what has this week cost me,
 * which model did the work, which tools does it actually reach for" — because
 * only the dashboard sums the `sessions` table that way.
 *
 * The payload is reshaped here rather than forwarded: upstream's answer
 * carries per-model capability metadata, auxiliary-task breakdowns and
 * per-skill timestamps this panel does not draw, and forwarding a payload
 * whole is how a route stops having a contract. `normalizeUsage()` is the
 * contract, and it is pure and tested.
 *
 * A missing token is a normal answer rather than an error: the panel says so
 * and disables itself, like the providers panel and the skills editor without
 * their bind mount. But a *failed* read is not the same answer, and `reason`
 * is what keeps the two apart — a refused token or a restarting dashboard
 * tells us nothing about the configuration, so it must reach the panel as
 * `failed` (retried on the next opening) and never as "this is turned off".
 * That is point 4 of the error contract, and the reason `availability.ts`
 * exists.
 */
interface UsagePayload {
	available: boolean;
	/**
	 * `disabled` — a successful read said the feature is off, and the message
	 * may name a remedy. `failed` — we could not read at all. `null` when
	 * `available`.
	 */
	reason: 'disabled' | 'failed' | null;
	/** Why the panel is off, when it is. Shown verbatim. */
	message: string;
	report: UsageReport;
}

const json = (payload: UsagePayload) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});

export const GET: RequestHandler = async ({ url }) => {
	const limited = gate('usage:read', 1, 4);
	if (limited) return limited;

	// Only the three windows the panel offers. Upstream would answer any value
	// in 1–365, and this route must not be the way to ask the Pi for a year of
	// sessions on every request.
	const days = resolvePeriod(url.searchParams.get('days'));

	if (!dashboardConfigured()) {
		return json({
			available: false,
			reason: 'disabled',
			message:
				"Le dashboard de Yadai n'est pas configuré (HERMES_DASHBOARD_TOKEN absent) : la consommation de l'agent n'est pas lisible.",
			report: emptyReport(days)
		});
	}

	try {
		return json({
			available: true,
			reason: null,
			message: '',
			report: normalizeUsage(await getUsageAnalytics(days), days)
		});
	} catch (err) {
		const message =
			err instanceof DashboardError
				? err.message
				: "La consommation de l'agent n'a pas pu être lue.";
		return json({ available: false, reason: 'failed', message, report: emptyReport(days) });
	}
};
