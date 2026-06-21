import { createFileRoute } from "@tanstack/react-router";

import { db, schema } from "~/db";
import { invalidateOrgCreditedCache, getOrgIdByPolarCustomerId } from "~/lib/server/polar";
import { RedisKeys } from "~/lib/server/redis-keys";
import { kv } from "~/lib/server/kv";

/**
 * Polar webhook handler.
 *
 * Polar verifies the signature via the `Webhook-*` headers; we read the
 * raw body and call `validateEvent`. We:
 *   1. Dedup by `webhook-id` header (24h TTL Redis SET).
 *   2. Filter by event type — ignore anything we don't care about.
 *   3. For relevant events, derive the org and invalidate the
 *      `creditedUnits` cache so the next proxy gate sees fresh data.
 *
 * The meter_credit benefit on the credits product grants credits on
 * `order.paid`; `order.refunded` reverses; `customer.state_changed`
 * covers benefit grants/revocations made outside the checkout flow.
 */
export const Route = createFileRoute("/api/polar/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { validateEvent } = await import("@polar-sh/sdk/webhooks");
        const raw = await request.text();
        const { serverEnv } = await import("~/env/server");
        const { eq } = await import("drizzle-orm");

        let payload: { type?: string; data?: unknown };
        try {
          payload = (await validateEvent(
            raw,
            Object.fromEntries(request.headers.entries()),
            serverEnv.POLAR_WEBHOOK_SECRET,
          )) as { type?: string; data?: unknown };
        } catch (err) {
          return new Response(`signature verification failed: ${(err as Error).message}`, {
            status: 401,
          });
        }

        // 1. Dedup by webhook-id.
        const webhookId = request.headers.get("webhook-id") ?? `${payload.type}-${Date.now()}`;
        const alreadyProcessed = await kv.sismember(RedisKeys.webhookIds(), webhookId);
        if (alreadyProcessed) {
          return new Response("ok (duplicate)");
        }
        await kv.sadd(RedisKeys.webhookIds(), webhookId);
        // Refresh 24h TTL on the SET so the dedup window doesn't grow forever.
        await kv.expire(RedisKeys.webhookIds(), 60 * 60 * 24);

        // 2. Filter by event type.
        switch (payload.type) {
          case "order.paid":
          case "order.refunded":
          case "customer.state_changed":
            break;
          default:
            return new Response("ok (ignored)");
        }

        // 3. Derive the org and invalidate the cache.
        const data = payload.data as {
          customerId?: string;
          externalCustomerId?: string | null;
          metadata?: Record<string, unknown>;
        };

        let orgId: string | null = null;
        const orgIdFromMetadata =
          typeof data.metadata?.["orgId"] === "string" ? (data.metadata["orgId"] as string) : null;
        if (orgIdFromMetadata) {
          orgId = orgIdFromMetadata;
        } else if (data.externalCustomerId) {
          // customer.state_changed payloads carry externalCustomerId directly.
          // First, look up the org by externalCustomerId.
          const rows = await db
            .select({ id: schema.organization.id })
            .from(schema.organization)
            .where(eq(schema.organization.polarCustomerId, data.externalCustomerId))
            .limit(1);
          orgId = rows[0]?.id ?? null;
        } else if (data.customerId) {
          orgId = await getOrgIdByPolarCustomerId(data.customerId);
        }

        if (orgId) {
          await invalidateOrgCreditedCache(orgId);
        }

        return new Response("ok");
      },
    },
  },
});
