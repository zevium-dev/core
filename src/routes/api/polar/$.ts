import { createFileRoute } from "@tanstack/react-router";

import { CreditsRedisKey } from "~/lib/shared/credits-keys";

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
          // Dynamic imports to avoid bundling server-only code in client
          const [{ serverEnv }, { CreditsManager }, { kv }, { validateEvent }] = await Promise.all([
            import("~/env/server"),
            import("~/lib/server/credits"),
            import("~/lib/server/kv"),
            import("@polar-sh/sdk/webhooks"),
          ]);

          // Read raw body for signature verification
          const raw = await request.text();
          const payloadUnknown: unknown = (() => {
            try {
              // Validate signature; throws if invalid
              return validateEvent(raw, Object.fromEntries(request.headers.entries()), serverEnv.POLAR_WEBHOOK_SECRET);
            } catch (err) {
              const error = new Error("Polar webhook signature verification failed", { cause: err });
              throw error;
            }
          })();

          const payload = payloadUnknown as
            | {
                data?: unknown;
                type?: unknown;
              }
            | null
            | undefined;

          try {
            if (payload?.type === "order.paid") {
              const order = payload.data as {
                checkoutId: null | string;
                currency: string;
                id: string;
                metadata?: Record<string, unknown>;
                productId: null | string;
                totalAmount: number;
              };

              // Only process our credits product
              if (!order.productId || order.productId !== serverEnv.POLAR_PRODUCT_ID_CREDITS) {
                return new Response("ignored", { status: 200 });
              }

              const metadataUserId = order.metadata?.userId;
              const userId = typeof metadataUserId === "string" ? metadataUserId : "";
              if (!userId) {
                return new Response("ignored: no userId", { status: 200 });
              }

              // Unified idempotency across checkout + order events
              const dedupeId = order.checkoutId ?? order.id;
              const appliedKey = CreditsRedisKey.creditApplied({ checkoutId: dedupeId, userId });
              const applyOk = await kv
                .set(appliedKey, "1", { nx: true, px: 1000 * 60 * 60 * 24 * 365 })
                .catch(() => null);
              if (applyOk !== "OK") {
                return new Response("ok");
              }

              const amountCents = order.totalAmount;
              if (amountCents > 0) {
                await CreditsManager.add({
                  amountCents,
                  description: "Polar top-up",
                  reference: order.id,
                  userId,
                });
              }
              return new Response("ok");
            }

            return new Response("ignored", { status: 200 });
          } catch (err) {
            const error = new Error("Polar webhook processing failed", { cause: err });
            throw error;
          }
        }
        return new Response("Not Found", { status: 404 });
      },
    },
  },
});
