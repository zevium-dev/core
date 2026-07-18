/**
 * CORS for the public gateway surfaces. The gateway is a public API —
 * browser callers (catalogue try-it, third-party dashboards, agent UIs)
 * must be able to reach /gateway, /mock, /discovery, and /mcp from any
 * origin. Auth is bearer-key based, never cookie-based, so a wildcard
 * origin does not widen the attack surface.
 */

const ALLOW_HEADERS = "authorization, x-api-key, content-type, accept";
const EXPOSE_HEADERS =
  "x-zevium-cost, x-zevium-request-id, x-zevium-free-tier, x-zevium-mock, deprecation, sunset, link";

/** Terminal response for OPTIONS preflights. */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": ALLOW_HEADERS,
      "access-control-max-age": "86400",
    },
  });
}

/** Add CORS headers onto an outgoing response (streams untouched). */
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
