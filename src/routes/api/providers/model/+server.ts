import type { RequestHandler } from './$types';
import { errorResponse, gate, readJson } from '$lib/server/respond';
import { dashboardResponse, setMainModel } from '$lib/server/dashboard';

interface ModelBody {
	provider?: unknown;
	model?: unknown;
	confirm_expensive_model?: unknown;
}

/**
 * Point Hermes' GLOBAL default (`config.yaml`) at another provider/model.
 *
 * Distinct from `POST /api/sessions/{id}/model` on the gateway, which re-pins
 * the conversation that is open: this one only affects sessions created after
 * it. Both exist because they answer different questions.
 *
 * A model the cost guard considers expensive comes back as
 * `{ok: false, confirm_required: true, confirm_message}` with nothing written;
 * the caller replays with `confirm_expensive_model: true`.
 */
export const POST: RequestHandler = async ({ request }) => {
	const limited = gate('providers-write', 1, 5);
	if (limited) return limited;

	const parsed = await readJson<ModelBody>(request);
	if ('response' in parsed) return parsed.response;

	const { provider, model, confirm_expensive_model } = parsed.body;
	if (typeof provider !== 'string' || !provider.trim()) {
		return errorResponse(400, 'Choose a provider.', 'missing_provider');
	}
	if (typeof model !== 'string' || !model.trim()) {
		return errorResponse(400, 'Choose a model.', 'missing_model');
	}

	return dashboardResponse(() =>
		setMainModel({
			provider: provider.trim(),
			model: model.trim(),
			confirm_expensive_model: confirm_expensive_model === true
		})
	);
};
