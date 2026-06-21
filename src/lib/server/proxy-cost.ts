import { serverEnv } from "~/env/server";

/**
 * Per-host cost lookup.
 *
 * `PROXY_HOST_UNIT_COSTS` is a JSON object of `{ host: costUnits }` (declared
 * as an arktype record in `src/env/server.ts`). The map is rebuilt on EVERY
 * call from `serverEnv` — we deliberately do NOT cache it at module scope.
 *
 * Why no cache: this is a serverless environment. A module-level cache would
 * live for the lifetime of a warm isolate with no invalidation path, so a
 * rotated `PROXY_HOST_UNIT_COSTS` secret would stay stale until the isolate
 * is recycled. Rebuilding each call is cheap (a tiny JSON parse + Map build)
 * relative to the Redis + Polar round-trips the proxy already makes, and it
 * keeps the cost map always consistent with the currently-loaded env.
 *
 * Normalization of the requested host (lowercase, no port, no trailing dot)
 * is applied before lookup. Fail-closed: an unpriced host throws; the caller
 * (proxy) translates that to 403.
 */

function buildCostMap(): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const raw = serverEnv.PROXY_HOST_UNIT_COSTS;
  for (const [host, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      throw new Error(`Invalid cost for host "${host}": ${value}. Must be a positive integer <= 1_000_000.`);
    }
    const normalized = host.trim().toLowerCase().replace(/\.$/, "").split(":")[0] ?? host;
    if (normalized) out.set(normalized, Math.floor(value));
  }
  if (out.size === 0) {
    throw new Error("PROXY_HOST_UNIT_COSTS is empty. At least one host is required.");
  }
  return out;
}

/**
 * Normalize a host header value to the form used as a key in the cost map.
 * Throws if the value is not a parseable HTTPS host.
 */
export function normalizeHost(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty host header");
  const candidate = /^(https?:)?\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid host: ${input}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Only HTTPS hosts are allowed: ${input}`);
  }
  return (url.hostname || "").toLowerCase().replace(/\.$/, "");
}

/**
 * Look up the cost for a (normalized) host. Throws on miss or invalid cost.
 */
export function getHostCost(normalizedHost: string): number {
  const cost = buildCostMap().get(normalizedHost);
  if (cost === undefined) {
    throw new Error(`Unpriced host: ${normalizedHost}. Add it to PROXY_HOST_UNIT_COSTS.`);
  }
  return cost;
}
