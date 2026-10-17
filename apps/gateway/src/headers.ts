/**
 * Headers excluded from forwarding, including hop-by-hop fields (RFC 9110 §7.6.1).
 */

const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  // Request auth must not leak to upstream; gateway authenticates itself later.
  "payment-signature": true,
  "payment-required": true,
  "payment-response": true,
  authorization: true,
  "x-api-key": true,
  // Cloudflare / intermediate noise
  "cf-connecting-ip": true,
  "cf-ipcountry": true,
  "cf-ray": true,
  "cf-visitor": true,
  "cdn-loop": true,
};

/**
 * Method-override headers make some upstream frameworks run a different method
 * than the one the gateway matched, priced and (for MCP) gated as read or
 * write. The request method is the only method an upstream may see.
 */
export const METHOD_OVERRIDE_HEADERS: ReadonlySet<string> = new Set([
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);

// Connection options name additional hop-by-hop fields, case-insensitively.
function connectionFields(source: Headers): Set<string> {
  return new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Build a Headers object for the upstream request: copy request headers,
 * strip hop-by-hop, consumer auth, method overrides, forwarding identity and
 * internal metadata.
 * Drop host (fetch sets it from URL).
 */
export function filterRequestHeaders(source: Headers): Headers {
  const out = new Headers();
  const nominated = connectionFields(source);
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (Object.hasOwn(HOP_BY_HOP, lower) || nominated.has(lower)) return;
    // Only the gateway may supply platform metadata, after filtering.
    if (lower.startsWith("x-zevium-")) return;
    if (METHOD_OVERRIDE_HEADERS.has(lower)) return;
    if (
      lower === "forwarded" ||
      lower.startsWith("x-forwarded-") ||
      lower === "x-real-ip"
    )
      return;
    if (lower === "cookie") return;
    if (lower === "host") return;
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}

/**
 * Build response headers for the client: strip hop-by-hop and internal metadata.
 */
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  const nominated = connectionFields(source);
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (Object.hasOwn(HOP_BY_HOP, lower) || nominated.has(lower)) return;
    // Only the gateway may supply platform metadata, after filtering.
    if (lower.startsWith("x-zevium-")) return;
    if (lower === "set-cookie") return;
    // Let runtime recompute content-length for streamed bodies.
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}
