import { env } from '$env/dynamic/private';
import type { Handle } from '@sveltejs/kit';

/**
 * Runtime cross-site request check.
 *
 * There is no login here — the tailnet is the authentication boundary. That
 * makes an origin check load-bearing rather than redundant: any web page open
 * on a tailnet device could otherwise POST to this app and drive the agent
 * (which has a terminal) with no credential of its own to steal.
 *
 * SvelteKit's built-in check is compiled in at build time and cannot know the
 * Serve hostname of the host running the image, so it is disabled in
 * svelte.config.js and replaced here, reading the environment at boot.
 *
 * Browsers always attach `Origin` to POST/PATCH/PUT/DELETE, cross-site or not.
 * A missing `Origin` therefore means a non-browser client (curl, the smoke
 * script, a healthcheck) and is allowed; a present-but-unknown one is refused.
 */

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedOrigins(): Set<string> {
	const origins = new Set<string>();
	const configured = env.HERMES_PUBLIC_ORIGIN?.trim();
	if (configured) origins.add(configured.replace(/\/+$/, ''));

	// Local development and direct loopback access.
	const port = env.PORT || '3000';
	origins.add(`http://localhost:${port}`);
	origins.add(`http://127.0.0.1:${port}`);
	origins.add('http://localhost:5173');
	origins.add('http://127.0.0.1:5173');
	return origins;
}

const ALLOWED = allowedOrigins();

export const handle: Handle = async ({ event, resolve }) => {
	if (UNSAFE.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		// `event.url.origin` is the app's own origin as seen behind the proxy;
		// accepting it keeps same-origin requests working whatever hostname
		// Tailscale Serve presents.
		if (origin && origin !== event.url.origin && !ALLOWED.has(origin)) {
			return new Response(
				JSON.stringify({
					error: {
						message:
							`Origin refused: ${origin}. ` +
							`Set HERMES_PUBLIC_ORIGIN to the Tailscale Serve URL.`,
						code: 'forbidden_origin'
					}
				}),
				{ status: 403, headers: { 'Content-Type': 'application/json' } }
			);
		}
	}

	const response = await resolve(event);

	// This app embeds no third-party anything, and the agent's own output is
	// rendered as sanitised markdown — so the policy can be maximally strict.
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Frame-Options', 'DENY');
	return response;
};
