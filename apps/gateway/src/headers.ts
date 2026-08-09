/**
 * Hop-by-hop headers that must not be forwarded (RFC 7230 §6.1).
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

/**
 * Build a Headers object for the upstream request: copy request headers,
 * strip hop-by-hop + consumer auth, drop host (fetch sets it from URL).
 */
export function filterRequestHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower in HOP_BY_HOP) return;
    if (lower === "cookie") return;
    if (lower === "host") return;
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}

/**
 * Build response headers for the client: copy upstream, strip hop-by-hop.
 */
export function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower in HOP_BY_HOP) return;
    if (lower === "set-cookie") return;
    // Let runtime recompute content-length for streamed bodies.
    if (lower === "content-length") return;
    out.append(key, value);
  });
  return out;
}
