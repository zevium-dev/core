import { and, eq } from "drizzle-orm";

import { db, schema } from "~/db";

/**
 * Per-host config lookup (DB-backed, user-scoped).
 *
 * Each user configures their own upstream API hosts with per-call credit
 * costs. The proxy route queries this after resolving the userId from the
 * API key. If no row exists for `(userId, host)`, the host is not allowed
 * for that user → the proxy returns 403.
 *
 * Normalization of the requested host (lowercase, no port, no trailing dot)
 * is applied by the caller via `normalizeHost` before calling this.
 */

export interface ProxyHostConfig {
  host: string;
  unitCost: number;
}

/**
 * Look up the host config for a user. Returns `null` if the host is not
 * configured for this user (not allowed).
 */
export async function getProxyHostConfig(userId: string, normalizedHost: string): Promise<ProxyHostConfig | null> {
  const row = await db
    .select({ host: schema.proxyHost.host, unitCost: schema.proxyHost.unitCost })
    .from(schema.proxyHost)
    .where(and(eq(schema.proxyHost.userId, userId), eq(schema.proxyHost.host, normalizedHost)))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!row) return null;
  return { host: row.host, unitCost: row.unitCost };
}

/**
 * Normalize a host header value. Throws if the value is not a parseable
 * HTTPS host.
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
