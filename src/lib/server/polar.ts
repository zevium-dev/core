import { Polar } from "@polar-sh/sdk";
import { eq } from "drizzle-orm";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { kv } from "~/lib/server/kv";
import { RedisKeys } from "~/lib/server/redis-keys";

/**
 * Polar SDK client + user-scoped helpers.
 *
 * Polar customer = authenticated user (`externalId = userId`); the
 * `@polar-sh/better-auth` plugin auto-creates the customer on signup. These
 * helpers cover the surfaces the plugin doesn't expose: the proxy route (no
 * auth session, just an API key → userId) needs to read the user's meter
 * `creditedUnits` and ingest `proxy_call` events.
 *
 * The plugin handles: top-up checkout (`/api/auth/checkout`), customer
 * portal/state (`/api/auth/customer/state`), usage meters
 * (`/api/auth/usage/meters/list`), and webhook signature verification
 * (`/api/auth/polar/webhooks`). Use the plugin endpoints everywhere the
 * session user is available; use these helpers only for server-side work.
 */

export const polarClient = new Polar({
  accessToken: serverEnv.POLAR_ACCESS_TOKEN,
  server: serverEnv.POLAR_SERVER,
});

/** Five-minute TTL on the `creditedUnits` cache. Self-heals missed webhooks. */
const CREDITED_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Idempotently ensure a Polar customer exists for the user and return the
 * Polar internal customer id. Used by the proxy route (no session) and as a
 * lazy backfill for users created before the plugin was wired. Caller can
 * pass a pre-fetched email/name to skip the DB read; otherwise we look up
 * the user table.
 */
export async function ensureUserCustomer(input: {
  userId: string;
  email?: string;
  name?: string | null;
}): Promise<string> {
  try {
    const existing = await polarClient.customers.getExternal({ externalId: input.userId });
    return existing.id;
  } catch {
    // 404 / not found → create.
    const email = input.email ?? (await readUserForPolar(input.userId)).email;
    const created = await polarClient.customers.create({
      email,
      externalId: input.userId,
      metadata: { userId: input.userId },
      name: input.name ?? undefined,
    });
    return created.id;
  }
}

/**
 * Read the user's total `creditedUnits` from Polar, with a 5-min Redis
 * cache. Returns 0 if no active meter or any error (the gate then
 * produces 402, not a 500). Lazy-creates the Polar customer for legacy
 * users so the proxy route works without a session.
 */
export async function getUserCreditedUnits(userId: string): Promise<number> {
  const cacheKey = RedisKeys.creditedUnits(userId);
  const cached = await kv.get<number>(cacheKey);
  if (typeof cached === "number" && Number.isFinite(cached)) {
    return cached;
  }
  let credited = 0;
  try {
    const state = await polarClient.customers.getStateExternal({
      externalId: userId,
    });
    const meter = state.activeMeters.find(
      (m: { meterId: string; creditedUnits: number }) => m.meterId === serverEnv.POLAR_METER_ID,
    );
    credited = meter?.creditedUnits ?? 0;
  } catch {
    // No Polar customer (legacy user) or Polar outage → treat as 0 so the
    // gate produces 402, not 500. The webhook will refresh the cache once
    // the customer is created (via plugin signup or first successful top-up).
    return 0;
  }
  await kv.set(cacheKey, credited, { ex: Math.ceil(CREDITED_CACHE_TTL_MS / 1000) });
  return credited;
}

/**
 * Invalidate the `creditedUnits` cache for a user. Call from the Polar
 * webhook handler on `order.paid`, `order.refunded`, and
 * `customer.state_changed` so the next gate read sees fresh data.
 */
export async function invalidateUserCreditedCache(userId: string): Promise<void> {
  await kv.del(RedisKeys.creditedUnits(userId));
}

/**
 * Resolve the user's email/name for the lazy-create path. The Polar
 * plugin auto-creates on signup; this is only used as a fallback for
 * proxy-route calls on users created before the plugin was wired.
 */
async function readUserForPolar(userId: string): Promise<{ email: string; name: string | null }> {
  const rows = await db
    .select({ email: schema.user.email, name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  const row = rows.at(0);
  return { email: row?.email ?? `${userId}@billing.zevium.dev`, name: row?.name ?? null };
}

/**
 * Ingest a `proxy_call` event so Polar auto-deducts `cost_units` from the
 * user's meter balance. `externalId = requestId` for dedup.
 *
 * Used by the proxy route (API-key auth, no session). In-app usage that
 * has a session should use the plugin's `usage.ingest` endpoint instead.
 */
export async function ingestProxyCall(input: {
  userId: string;
  requestId: string;
  host: string;
  method: string;
  status: number;
  costUnits: number;
}): Promise<void> {
  await polarClient.events.ingest({
    events: [
      {
        externalCustomerId: input.userId,
        externalId: input.requestId,
        metadata: {
          cost_units: input.costUnits,
          host: input.host,
          method: input.method,
          status: input.status,
        },
        name: "proxy_call",
      } as never,
    ],
  });
}
