import { Polar } from "@polar-sh/sdk";
import { eq } from "drizzle-orm";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { kv } from "~/lib/server/kv";
import { RedisKeys } from "~/lib/server/redis-keys";

/**
 * Polar SDK client + org-scoped helpers.
 *
 * Replaces the user-scoped `polar()` Better Auth plugin and the
 * self-managed `CreditsManager`. Every operation is org-scoped; each
 * org has one Polar customer (externalId = orgId) and a per-org credit
 * meter pool. The proxy charges by ingesting `proxy_call` events with
 * a `cost_units` metadata; the meter_credit benefit grants credits on
 * `order.paid`.
 */
export const polarClient = new Polar({
  accessToken: serverEnv.POLAR_ACCESS_TOKEN,
  server: serverEnv.POLAR_SERVER,
});

/** Five-minute TTL on the `creditedUnits` cache. Self-heals missed webhooks. */
const CREDITED_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-org deterministic email so we never collide on the org-scoped
 * Polar org's email-uniqueness rule. Not a real inbox.
 */
function orgBillingEmail(orgId: string): string {
  return `org-${orgId}@billing.zevium.dev`;
}

/**
 * Idempotently ensure a Polar customer exists for the org. Sets
 * `organization.polarCustomerId` on success.
 *
 * Strategy: list first by `externalId`. If found, persist the
 * existing Polar customer id (covers a previous run that created
 * the customer but failed to persist the id). If not found, create
 * and persist. The "getExternal" call is cheap and reliable;
 * we do not rely on race-prone create-then-catch-duplicate.
 */
export async function ensureOrgCustomer(org: {
  id: string;
  name: string;
  polarCustomerId: string | null;
  polarBillingEmail: string | null;
}): Promise<{ id: string; email: string }> {
  if (org.polarCustomerId) {
    return { id: org.polarCustomerId, email: org.polarBillingEmail ?? orgBillingEmail(org.id) };
  }

  let customerId: string;
  let email = org.polarBillingEmail ?? orgBillingEmail(org.id);

  try {
    const existing = await polarClient.customers.getExternal({ externalId: org.id });
    customerId = existing.id;
  } catch {
    const created = await polarClient.customers.create({
      externalId: org.id,
      email,
      metadata: { orgId: org.id },
      name: org.name,
    });
    customerId = created.id;
  }

  await db
    .update(schema.organization)
    .set({ polarCustomerId: customerId, polarBillingEmail: email })
    .where(eq(schema.organization.id, org.id));

  return { id: customerId, email };
}

/**
 * Read the org's total `creditedUnits` from Polar, with a 5-min Redis
 * cache. Returns 0 if no active meter or any error (the gate then
 * produces 402, not a 500).
 */
export async function getOrgCreditedUnits(orgId: string): Promise<number> {
  const cacheKey = RedisKeys.creditedUnits(orgId);
  const cached = await kv.get<number>(cacheKey);
  if (typeof cached === "number" && Number.isFinite(cached)) {
    return cached;
  }
  const state = await polarClient.customers.getStateExternal({
    externalId: orgId,
  });
  const meter = state.activeMeters.find(
    (m: { meterId: string; creditedUnits: number }) => m.meterId === serverEnv.POLAR_METER_ID,
  );
  const credited = meter?.creditedUnits ?? 0;
  await kv.set(cacheKey, credited, { ex: Math.ceil(CREDITED_CACHE_TTL_MS / 1000) });
  return credited;
}

/**
 * Invalidate the `creditedUnits` cache for an org. Call from the webhook
 * handler on `order.paid`, `order.refunded`, and `customer.state_changed`
 * so the next gate read sees fresh data.
 */
export async function invalidateOrgCreditedCache(orgId: string): Promise<void> {
  await kv.del(RedisKeys.creditedUnits(orgId));
}

/**
 * Create a Polar checkout for a top-up. Uses the per-org customer so
 * the meter_credit benefit on the credits product lands on the org's
 * customer. Variable amount: caller passes the USD amount (>= 20).
 */
export async function createCreditsCheckout(input: {
  orgId: string;
  amountUsd: number;
  successUrl: string;
}): Promise<{ url: string; checkoutId: string }> {
  if (input.amountUsd < 20) {
    throw new Error("Minimum top-up is $20.");
  }

  const { id: customerId } = await ensureOrgCustomer({
    id: input.orgId,
    name: input.orgId,
    polarCustomerId: await getOrgCustomerId(input.orgId),
    polarBillingEmail: null,
  });
  const productId = serverEnv.POLAR_PRODUCT_ID_CREDITS;
  const checkout = await polarClient.checkouts.create({
    customerId,
    metadata: { orgId: input.orgId },
    prices: {
      [productId]: [{ amountType: "custom", presetAmount: input.amountUsd * 100, priceCurrency: "usd" }],
    },
    products: [productId],
    successUrl: input.successUrl,
  });

  return {
    url: typeof checkout.url === "string" ? checkout.url : input.successUrl,
    checkoutId: checkout.id,
  };
}

/**
 * Ingest a `proxy_call` event so Polar auto-deducts `cost_units`
 * from the org's meter balance. `externalId = requestId` for
 * dedup.
 */
export async function ingestProxyCall(input: {
  orgId: string;
  requestId: string;
  host: string;
  method: string;
  status: number;
  costUnits: number;
}): Promise<void> {
  await polarClient.events.ingest({
    events: [
      {
        name: "proxy_call",
        externalCustomerId: input.orgId,
        externalId: input.requestId,
        metadata: {
          cost_units: input.costUnits,
          host: input.host,
          method: input.method,
          status: input.status,
        },
      } as never,
    ],
  });
}

/**
 * Resolve the Polar customer id for an org. Returns null if not yet
 * linked (caller decides whether to lazy-create).
 */
async function getOrgCustomerId(orgId: string): Promise<string | null> {
  const rows = await db
    .select({ polarCustomerId: schema.organization.polarCustomerId })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  return rows[0]?.polarCustomerId ?? null;
}

/**
 * Resolve the orgId from a Polar customerId. Used by the webhook
 * handler to map `order.paid` / `order.refunded` payloads (which
 * carry the Polar customer id, not our externalId) to the org.
 */
export async function getOrgIdByPolarCustomerId(polarCustomerId: string): Promise<string | null> {
  const rows = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.polarCustomerId, polarCustomerId))
    .limit(1);
  return rows[0]?.id ?? null;
}
