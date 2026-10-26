import { api } from '$lib/client/api';
import { toasts } from './toast.svelte';
import {
	DEFAULT_POLICY,
	planPolicyUpdate,
	type ApprovalMode,
	type ApprovalPolicy,
	type PolicyBaseline
} from '$lib/approvals';

interface ApprovalsResponse extends ApprovalPolicy {
	available: boolean;
	message: string;
}

/**
 * The dangerous-command approval policy.
 *
 * `loaded` is the whole point: `baseline` stays `null` until a read has
 * actually succeeded, and every write composes on it. Writing a policy we
 * failed to read would replace the user's deny rules with an empty list — and
 * those rules are the ones that block a command even under `--yolo`.
 */
class ApprovalsStore {
	policy = $state<ApprovalPolicy>({ ...DEFAULT_POLICY });
	available = $state(false);
	message = $state('');
	loaded = $state(false);
	loading = $state(false);
	saving = $state(false);

	get baseline(): PolicyBaseline {
		return this.loaded ? this.policy : null;
	}

	async load() {
		this.loading = true;
		try {
			const res = await api<ApprovalsResponse>('/api/approvals');
			this.policy = { mode: res.mode, deny: res.deny, allowlist: res.allowlist };
			this.available = res.available;
			this.message = res.message;
			this.loaded = res.available;
		} catch (err) {
			this.available = false;
			this.loaded = false;
			toasts.error(err, { label: 'Retry', run: () => void this.load() });
		} finally {
			this.loading = false;
		}
	}

	/** Read once per opening, and retry there: a transient failure heals itself. */
	async ensureLoaded() {
		if (!this.loaded) await this.load();
	}

	async update(patch: Partial<ApprovalPolicy>) {
		await this.ensureLoaded();
		const plan = planPolicyUpdate(this.baseline, patch);
		if (!plan.ok) {
			toasts.info('The policy could not be read: nothing was written.');
			return;
		}
		const previous = this.policy;
		this.policy = plan.policy;
		this.saving = true;
		try {
			const res = await api<ApprovalsResponse>('/api/approvals', {
				method: 'PUT',
				body: JSON.stringify({ policy: plan.policy })
			});
			this.policy = { mode: res.mode, deny: res.deny, allowlist: res.allowlist };
			toasts.success('Policy saved.');
		} catch (err) {
			this.policy = previous;
			toasts.error(err);
		} finally {
			this.saving = false;
		}
	}

	setMode = (mode: ApprovalMode) => this.update({ mode });

	addRule = (list: 'deny' | 'allowlist', value: string) => {
		const entry = value.trim();
		if (!entry) return Promise.resolve();
		return this.update({ [list]: [...this.policy[list], entry] });
	};

	removeRule = (list: 'deny' | 'allowlist', value: string) =>
		this.update({ [list]: this.policy[list].filter((e) => e !== value) });
}

export const approvals = new ApprovalsStore();
