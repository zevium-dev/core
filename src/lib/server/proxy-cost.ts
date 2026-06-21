import { serverEnv } from "~/env/server";

/**
 * Per-host cost lookup.
 *
 * `PROXY_HOST_UNIT_COSTS` is a JSON object of `{ host: costUnits }` in env
 * (declared as an arktype record in `src/env/server.ts`). The map is
 * parsed once at module load and frozen. Normalization of the requested
 * host (lowercase, no port, no trailing dot) is applied before lookup.
 *
 * Fail-closed: an unpriced host throws. Caller (proxy) translates to 403.
 */

let costs: ReadonlyMap<string, number> | null = null;

function parseCosts(): ReadonlyMap<string, number> {
  if (costs) return costs;
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
  costs = out;
  return costs;
}

/**
 * Normalize a host header value to the form used as a key in the cost map.
 * Throws if the value is not a parseable host.
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
  const map = parseCosts();
  const cost = map.get(normalizedHost);
  if (cost === undefined) {
    throw new Error(`Unpriced host: ${normalizedHost}. Add it to PROXY_HOST_UNIT_COSTS.`);
  }
  return cost;
}

/** Test helper: reset the cached cost map. */
export function clearCostCacheForTests(): void {
  costs = null;
}
