import { api } from '$lib/client/api';
import { humanizeError } from '$lib/errors';
import { panelState, type PanelState } from '$lib/availability';
import { toasts } from './toast.svelte';
import { scheduleExpression, sortJobs, usableTargets, type DeliveryTarget } from '$lib/jobs';
import type { HermesJob } from '$lib/types';

interface JobsResponse {
	jobs: HermesJob[];
	targets: DeliveryTarget[];
	targetsAvailable: boolean;
}

/**
 * A task as the form holds it.
 *
 * `instruction` is what the user typed — the prompt Hermes stores also carries
 * the agent's card, and only the server composes the two (`jobPromptFor`).
 */
export interface JobInput {
	name: string;
	schedule: string;
	instruction: string;
	agentId: string | null;
	deliver: string;
}

/**
 * State of the scheduled-jobs panel.
 *
 * Its own store, like the skills editor: nothing here touches a conversation,
 * and it stays dormant until the panel is opened for the first time. Every
 * mutation re-reads the list rather than patching a row in place — the upstream
 * recomputes `state`, `next_run_at` and the repeat counter on each action, and
 * guessing those locally is how a panel starts lying.
 */
class JobsStore {
	/** null before the first load: "unknown", not "empty". */
	jobs = $state<HermesJob[] | null>(null);
	targets = $state<DeliveryTarget[]>([]);
	loading = $state(false);
	/** Set when the gateway has no cron module (HTTP 501). */
	unavailable = $state(false);
	/**
	 * Why the last listing failed, or null once one succeeds.
	 *
	 * Without it, a failed read left `jobs` at null and the panel printed
	 * "Aucune tâche planifiée" — a flat statement about a list it had never
	 * managed to fetch, in the one panel where believing it means scheduling
	 * the same task twice.
	 */
	loadError = $state<string | null>(null);
	/** Id of the job an action is running on, so only its buttons spin. */
	busyId = $state<string | null>(null);
	creating = $state(false);

	/** What the panel should show: unread, ready, off, or unreadable. */
	get state(): PanelState {
		return panelState({
			ready: this.jobs !== null,
			disabled: this.unavailable,
			error: this.loadError
		});
	}

	get sorted(): HermesJob[] {
		return sortJobs(this.jobs ?? []);
	}

	get deliveryChoices(): DeliveryTarget[] {
		return usableTargets(this.targets);
	}

	async refresh(quiet = false) {
		this.loading = true;
		try {
			const res = await api<JobsResponse>('/api/jobs', { timeoutMs: 15_000 });
			this.jobs = res.jobs ?? [];
			this.targets = res.targets ?? [];
			this.unavailable = false;
			this.loadError = null;
		} catch (err) {
			// 501 is Hermes saying it was built without the cron module — a
			// configuration fact to explain, not a failure to retry.
			if ((err as { status?: number })?.status === 501) {
				this.unavailable = true;
				this.jobs = [];
				this.loadError = null;
			} else {
				// Anything else leaves the list unknown. Saying so beats both an
				// empty list and a toast that fades: the panel shows the reason
				// and a retry, and `quiet` only decides whether a *mutation* also
				// shouts about a refresh it could not make.
				this.loadError = humanizeError(err);
				if (!quiet) toasts.error(err);
			}
		} finally {
			this.loading = false;
		}
	}

	/** Returns true when the job was created, so the form can close itself. */
	async create(input: JobInput): Promise<boolean> {
		if (this.creating) return false;
		this.creating = true;
		try {
			await api<{ job: HermesJob }>('/api/jobs', {
				method: 'POST',
				body: JSON.stringify(input),
				timeoutMs: 20_000
			});
			await this.refresh(true);
			toasts.success(`Task "${input.name}" scheduled.`);
			return true;
		} catch (err) {
			toasts.error(err);
			return false;
		} finally {
			this.creating = false;
		}
	}

	/**
	 * Save an edited task. Returns true when it went through.
	 *
	 * The whole form goes up every time — the server recomposes the prompt from
	 * the instruction and the agent, so sending half of it would compose half a
	 * prompt. `refresh()` afterwards rather than patching the row: upstream
	 * recomputes `next_run_at` from the new schedule and only it knows the answer.
	 */
	async update(id: string, input: JobInput): Promise<boolean> {
		if (this.creating || this.busyId) return false;
		this.creating = true;
		try {
			await api<{ job: HermesJob }>(`/api/jobs/${encodeURIComponent(id)}`, {
				method: 'PATCH',
				body: JSON.stringify(input),
				timeoutMs: 20_000
			});
			await this.refresh(true);
			toasts.success('Task saved.');
			return true;
		} catch (err) {
			toasts.error(err);
			return false;
		} finally {
			this.creating = false;
		}
	}

	/**
	 * Re-bake the agent's current card into a task whose prompt has drifted.
	 *
	 * Nothing else changes: the same name, schedule, instruction and delivery go
	 * back up, and the server composes the prompt again from the roster as it
	 * stands now.
	 */
	async resync(job: HermesJob): Promise<void> {
		if (!job.id || this.busyId) return;
		this.busyId = job.id;
		try {
			await api(`/api/jobs/${encodeURIComponent(job.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({
					name: job.name ?? '',
					schedule: scheduleExpression(job),
					instruction: job.instruction ?? '',
					agentId: job.agent_id ?? null,
					deliver: job.deliver ?? 'local'
				}),
				timeoutMs: 20_000
			});
			await this.refresh(true);
			toasts.success("Agent card refreshed on this task.");
		} catch (err) {
			toasts.error(err);
		} finally {
			this.busyId = null;
		}
	}

	async act(id: string, action: 'pause' | 'resume' | 'run') {
		if (this.busyId) return;
		this.busyId = id;
		try {
			await api(`/api/jobs/${encodeURIComponent(id)}`, {
				method: 'POST',
				body: JSON.stringify({ action }),
				timeoutMs: 20_000
			});
			await this.refresh(true);
			if (action === 'run') {
				toasts.success('Task started — the result will follow its delivery rule.');
			}
		} catch (err) {
			toasts.error(err);
		} finally {
			this.busyId = null;
		}
	}

	async remove(id: string) {
		if (this.busyId) return;
		this.busyId = id;
		try {
			await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 15_000 });
			this.jobs = (this.jobs ?? []).filter((job) => job.id !== id);
			toasts.success('Task deleted.');
		} catch (err) {
			toasts.error(err);
			await this.refresh(true);
		} finally {
			this.busyId = null;
		}
	}
}

export const jobsStore = new JobsStore();
