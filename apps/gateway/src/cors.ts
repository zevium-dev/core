/**
 * CORS for the public gateway surfaces. The gateway is a public API —
 * browser callers (catalogue try-it, third-party dashboards, agent UIs)
 * must be able to reach /gateway, /mock, /discovery, and /mcp from any
 * origin. Auth is bearer-key based, never cookie-based, so a wildcard
 * origin does not widen the attack surface.
 */

const ALLOW_HEADERS =
  "authorization, x-api-key, content-type, accept, payment-signature";
const EXPOSE_HEADERS =
  "x-zevium-cost, x-zevium-hold, retry-after, x-zevium-request-id, x-zevium-free-tier, x-zevium-mock, deprecation, sunset, link, payment-required, payment-response, x-zevium-wallet-session";

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

/** Apply CORS at the outer response boundary without wrapping the stream again. */
export function applyCorsHeaders(headers: Headers): void {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
}
