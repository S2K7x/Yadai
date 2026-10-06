import { api } from '$lib/client/api';
import { humanizeError } from '$lib/errors';
import { panelState, type PanelState } from '$lib/availability';
import {
	DEFAULT_USAGE_PERIOD,
	emptyReport,
	type UsagePeriod,
	type UsageReport
} from '$lib/usage';

interface UsageResponse {
	available: boolean;
	reason: 'disabled' | 'failed' | null;
	message: string;
	report: UsageReport;
}

/**
 * State of the consumption panel.
 *
 * Read-only from end to end: there is nothing to write, so there is no
 * baseline problem here and no optimistic half to hand back (points 15, 19,
 * 32). What there *is* instead is a period, and the period is the cache key —
 * answers are kept per window so switching back to one already read is
 * instant and costs the Pi nothing.
 *
 * Nothing loads until the panel is opened for the first time, like the skills
 * editor and the jobs panel.
 */
class UsageStore {
	period = $state<UsagePeriod>(DEFAULT_USAGE_PERIOD);
	loading = $state(false);
	/** Set when the dashboard said the feature is off (no token). */
	unavailable = $state(false);
	message = $state('');
	/** Why the last read failed, or null once one succeeds. */
	loadError = $state<string | null>(null);

	/** One report per window read so far. Switching back is free. */
	#reports = $state<Record<number, UsageReport>>({});

	get report(): UsageReport | null {
		return this.#reports[this.period] ?? null;
	}

	/** What the panel should show: unread, ready, off, or unreadable. */
	get state(): PanelState {
		return panelState({
			ready: this.report !== null,
			disabled: this.unavailable,
			error: this.loadError
		});
	}

	async load(period: UsagePeriod = this.period) {
		this.loading = true;
		try {
			const res = await api<UsageResponse>(`/api/usage?days=${period}`, { timeoutMs: 15_000 });
			if (res.available) {
				this.#reports = { ...this.#reports, [period]: res.report ?? emptyReport(period) };
				this.unavailable = false;
				this.message = '';
				this.loadError = null;
			} else if (res.reason === 'disabled') {
				// A read that succeeded and said "off" — the only state whose
				// explanation may name a configuration remedy.
				this.unavailable = true;
				this.message = res.message;
				this.loadError = null;
			} else {
				// A read we could not make says nothing about the configuration,
				// so it must not disable the panel. `failed` outranks `disabled`
				// and is the one state re-read on the next opening.
				this.loadError = res.message || "La consommation n'a pas pu être lue.";
			}
		} catch (err) {
			this.loadError = humanizeError(err);
		} finally {
			this.loading = false;
		}
	}

	/** Switch windows, fetching the new one only if it was never read. */
	async setPeriod(period: UsagePeriod) {
		this.period = period;
		if (!this.#reports[period]) await this.load(period);
	}

	/** Drop every cached window, then re-read the current one. */
	async refresh() {
		this.#reports = {};
		await this.load();
	}
}

export const usage = new UsageStore();
