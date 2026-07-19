const PRIVATE_IPV4 = (hostname: string): boolean => {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

const PRIVATE_IPV6 = (hostname: string): boolean => {
  const value = hostname.toLowerCase();
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
};

/**
 * Edge-safe origin policy. `global_fetch_strictly_public` in wrangler.jsonc
 * makes Cloudflare's global fetch reject private-network targets at egress;
 * this strict URL policy and the control-plane DNS probe are defense in depth.
 * DNS is not pinned by normal fetch, so a dedicated egress service remains the
 * escalation path if a stronger per-dial guarantee is ever required.
 */
export function assertSafeUpstreamTarget(url: URL): void {
  if (url.protocol !== "https:") throw new Error("unsafe_upstream");
  if (url.username || url.password || url.hash)
    throw new Error("unsafe_upstream");
  if (url.port !== "" && url.port !== "443") throw new Error("unsafe_upstream");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  )
    throw new Error("unsafe_upstream");
  if (PRIVATE_IPV4(hostname) || PRIVATE_IPV6(hostname))
    throw new Error("unsafe_upstream");
}
