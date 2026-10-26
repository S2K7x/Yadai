import type { RequestHandler } from './$types';
import { gate, readJson } from '$lib/server/respond';
import {
	DashboardError,
	dashboardConfigured,
	getHermesConfig,
	putHermesConfig
} from '$lib/server/dashboard';
import {
	normalizeApprovalPolicy,
	planPolicyUpdate,
	type ApprovalPolicy
} from '$lib/approvals';

/**
 * The dangerous-command approval policy, read and written through the
 * dashboard.
 *
 * Never by editing `config.yaml` ourselves — same rule as provider
 * credentials (point 13): the dashboard owns the file, we ask it. And never
 * by forwarding the config: `GET /api/config` answers with ~90 root keys,
 * several of them credentials mirrored out of `.env`. Exactly three fields
 * leave this route.
 */

interface ApprovalsPayload extends ApprovalPolicy {
	available: boolean;
	/** Why the panel is off, when it is. Shown verbatim. */
	message: string;
}

const json = (payload: ApprovalsPayload, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

const OFF: ApprovalPolicy = { mode: 'smart', deny: [], allowlist: [] };

export const GET: RequestHandler = async () => {
	const limited = gate('approvals:read', 2, 8);
	if (limited) return limited;

	// A missing token or a stopped dashboard is a normal answer, not an error:
	// the panel says so and disables itself, like the providers panel and the
	// skills editor without their bind mount.
	if (!dashboardConfigured()) {
		return json({
			...OFF,
			available: false,
			message:
				"The Hermes dashboard is not configured (HERMES_DASHBOARD_TOKEN missing): the approval policy cannot be read."
		});
	}

	try {
		const config = await getHermesConfig();
		const policy = normalizeApprovalPolicy(config.approvals, config.command_allowlist);
		return json({ ...policy, available: true, message: '' });
	} catch (err) {
		const message =
			err instanceof DashboardError
				? err.message
				: "The approval policy could not be read.";
		return json({ ...OFF, available: false, message });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	const limited = gate('approvals:write', 1, 5);
	if (limited) return limited;

	const parsed = await readJson<{ policy?: unknown; baseline?: unknown }>(request);
	if ('response' in parsed) return parsed.response;

	// The baseline is the policy the client actually read. Without it the deep
	// merge below would replace `deny` and `command_allowlist` with whatever
	// the client guessed — and a deep merge replaces a list wholesale.
	const raw = parsed.body.policy;
	if (!raw || typeof raw !== 'object') {
		return new Response(JSON.stringify({ error: { message: 'missing policy', code: 'invalid_body' } }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const policy = normalizeApprovalPolicy(raw, (raw as Record<string, unknown>).allowlist);
	const plan = planPolicyUpdate(policy, {});
	if (!plan.ok) {
		return new Response(
			JSON.stringify({ error: { message: 'policy not read', code: 'invalid_body' } }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	try {
		// Only these two root keys. Everything else on disk is left alone by the
		// dashboard's deep merge.
		await putHermesConfig({
			approvals: { mode: plan.policy.mode, deny: plan.policy.deny },
			command_allowlist: plan.policy.allowlist
		});
		return json({ ...plan.policy, available: true, message: '' });
	} catch (err) {
		const message =
			err instanceof DashboardError ? err.message : 'Saving failed.';
		const status = err instanceof DashboardError ? err.status : 502;
		return new Response(JSON.stringify({ error: { message, code: 'dashboard_error' } }), {
			status,
			headers: { 'Content-Type': 'application/json' }
		});
	}
};
