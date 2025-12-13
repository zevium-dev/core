import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";

import { serverEnv } from "~/env/server";
import { addCreditsTopUp } from "~/lib/server/credits";
import { kv } from "~/lib/server/kv";
import { validateEvent } from "@polar-sh/sdk/webhooks";

/**
 * Polar API routes
 * - POST /api/polar/webhook -> webhook handler
 */
export const Route = createFileRoute("/api/polar/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/webhook")) {
          // Read raw body for signature verification
          const raw = await request.text();
          let payload: any;
          try {
            // Validate signature; throws if invalid
            payload = validateEvent(raw, Object.fromEntries(request.headers.entries()), serverEnv.POLAR_WEBHOOK_SECRET);
          } catch (err) {
            console.error("[POLAR_WEBHOOK_VERIFY_ERROR]", err);
            return new Response("invalid signature", { status: 400 });
          }

          try {
            if (payload?.type === "order.paid") {
              const order = payload.data as {
                id: string;
                productId: string | null;
                totalAmount: number;
                currency: string;
                checkoutId: string | null;
                metadata?: Record<string, unknown>;
              };

              // Only process our credits product
              if (!order.productId || order.productId !== serverEnv.POLAR_PRODUCT_ID_CREDITS) {
                return new Response("ignored", { status: 200 });
              }

              const userId = String(order.metadata?.userId ?? "");
              if (!userId) {
                return new Response("ignored: no userId", { status: 200 });
              }

              // Unified idempotency across checkout + order events
              const dedupeId = order.checkoutId || order.id;
              const appliedKey = `polar:credit_applied:${userId}:${dedupeId}`;
              const applyOk = await kv
                .set(appliedKey, "1", { nx: true, px: 1000 * 60 * 60 * 24 * 365 })
                .catch(() => null);
              if (applyOk !== "OK") {
                return new Response("ok");
              }

              const amountCents = Number(order.totalAmount ?? 0);
              if (amountCents > 0) {
                await addCreditsTopUp(userId, amountCents, order.id ?? randomUUID(), "Polar top-up");
              }
              return new Response("ok");
            }

            return new Response("ignored", { status: 200 });
          } catch (err) {
            console.error("[POLAR_WEBHOOK_ERROR]", err);
            return new Response("error", { status: 500 });
          }
        }
        return new Response("Not Found", { status: 404 });
      },
    },
  },
});


