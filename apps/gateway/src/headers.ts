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
  authorization: true,
  "x-api-key": true,
  // Cloudflare / intermediate noise
  "cf-connecting-ip": true,
  "cf-ipcountry": true,
  "cf-ray": true,
  "cf-visitor": true,
  "cdn-loop": true,
};

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
 * strip hop-by-hop, consumer auth, forwarding identity and internal metadata.
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
