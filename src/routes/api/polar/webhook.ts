import { createFileRoute } from "@tanstack/react-router";

import { CreditsRedisKey } from "~/lib/shared/credits-keys";

const IDEMPOTENCY_APPLIED_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const IDEMPOTENCY_PENDING_TTL_MS = 1000 * 60 * 5;

/**
 * Polar API routes
 * - POST /api/polar/webhook -> webhook handler
 */
export const Route = createFileRoute("/api/polar/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Dynamic imports to avoid bundling server-only code in client
        const [{ serverEnv }, { CreditsManager }, { kv }, { validateEvent }, { createPostHogClient }] =
          await Promise.all([
            import("~/env/server"),
            import("~/lib/server/credits"),
            import("~/lib/server/kv"),
            import("@polar-sh/sdk/webhooks"),
            import("~/lib/server/posthog"),
          ]);

        const posthog = createPostHogClient();

        // Read raw body for signature verification
        const raw = await request.text();

        const payloadUnknown: unknown = (() => {
          try {
            // Validate signature; throws if invalid
            const validated = validateEvent(
              raw,
              Object.fromEntries(request.headers.entries()),
              serverEnv.POLAR_WEBHOOK_SECRET,
            );
            return validated;
          } catch (err) {
            const error = new Error("Polar webhook signature verification failed", { cause: err });
            posthog?.captureException(error, undefined, {
              bodyLength: raw.length,
              source: "polar_webhook",
            });
            void posthog?.shutdown();
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
              discountAmount?: number;
              id: string;
              metadata?: Record<string, unknown>;
              netAmount?: number;
              productId: null | string;
              subtotalAmount?: number;
              taxAmount?: number;
              totalAmount: number;
            };

            // Only process our credits product
            if (!order.productId || order.productId !== serverEnv.POLAR_PRODUCT_ID_CREDITS) {
              posthog?.capture({
                distinctId: "system",
                event: "polar_webhook_ignored",
                properties: {
                  expectedProductId: serverEnv.POLAR_PRODUCT_ID_CREDITS,
                  orderId: order.id,
                  productId: order.productId,
                  reason: "product_id_mismatch",
                },
              });
              void posthog?.shutdown();
              return new Response("ignored", { status: 200 });
            }

            const metadataUserId = order.metadata?.userId;
            const userId = typeof metadataUserId === "string" ? metadataUserId : "";

            if (!userId) {
              posthog?.capture({
                distinctId: "system",
                event: "polar_webhook_ignored",
                properties: {
                  metadata: order.metadata,
                  orderId: order.id,
                  reason: "no_user_id",
                },
              });
              void posthog?.shutdown();
              return new Response("ignored: no userId", { status: 200 });
            }

            // Unified idempotency across checkout + order events
            const dedupeId = order.checkoutId ?? order.id;
            const appliedKey = CreditsRedisKey.creditApplied({ checkoutId: dedupeId, userId });

            let applyOk: null | string = null;
            try {
              applyOk = await kv.set(appliedKey, "pending", { nx: true, px: IDEMPOTENCY_PENDING_TTL_MS });
            } catch (err) {
              posthog?.captureException(err, userId, {
                appliedKey,
                operation: "redis_set_idempotency",
                source: "polar_webhook",
              });
              void posthog?.shutdown();
              return new Response("temporary failure", { status: 500 });
            }

            if (applyOk !== "OK") {
              let idempotencyState: null | string = null;
              try {
                idempotencyState = await kv.get<string>(appliedKey);
              } catch (err) {
                posthog?.captureException(err, userId, {
                  appliedKey,
                  operation: "redis_get_idempotency_state",
                  source: "polar_webhook",
                });
                void posthog?.shutdown();
                return new Response("temporary failure", { status: 500 });
              }

              if (idempotencyState !== "applied") {
                posthog?.capture({
                  distinctId: userId,
                  event: "polar_webhook_in_progress",
                  properties: {
                    appliedKey,
                    checkoutId: order.checkoutId,
                    idempotencyState,
                    orderId: order.id,
                  },
                });
                void posthog?.shutdown();
                return new Response("temporary failure", { status: 500 });
              }

              posthog?.capture({
                distinctId: userId,
                event: "polar_webhook_duplicate",
                properties: {
                  appliedKey,
                  checkoutId: order.checkoutId,
                  orderId: order.id,
                },
              });
              void posthog?.shutdown();
              return new Response("ok");
            }

            // Credit the intended top-up amount (pre-discount, pre-tax).
            // Polar exposes this as `subtotalAmount`.
            // Fallbacks are defensive in case payload shape changes.
            const amountCents =
              typeof order.subtotalAmount === "number"
                ? order.subtotalAmount
                : typeof order.netAmount === "number" && typeof order.discountAmount === "number"
                  ? Math.max(0, order.netAmount + order.discountAmount)
                  : typeof order.taxAmount === "number"
                    ? Math.max(0, order.totalAmount - order.taxAmount)
                    : order.totalAmount;

            if (amountCents > 0) {
              let newBalance = 0;
              try {
                newBalance = await CreditsManager.add({
                  amountCents,
                  description: "Polar top-up",
                  reference: order.id,
                  userId,
                });
              } catch (err) {
                await kv.del(appliedKey).catch((rollbackErr) => {
                  posthog?.captureException(rollbackErr, userId, {
                    appliedKey,
                    operation: "redis_clear_idempotency_after_failed_apply",
                    source: "polar_webhook",
                  });
                });
                throw err;
              }

              posthog?.capture({
                distinctId: userId,
                event: "polar_webhook_credits_added",
                properties: {
                  amountCents,
                  checkoutId: order.checkoutId,
                  newBalance,
                  orderId: order.id,
                },
              });
            } else {
              posthog?.capture({
                distinctId: userId,
                event: "polar_webhook_skipped",
                properties: {
                  amountCents,
                  orderId: order.id,
                  reason: "zero_or_negative_amount",
                },
              });
            }

            let isIdempotencyFinalized = false;
            try {
              const finalized = await kv.set(appliedKey, "applied", {
                px: IDEMPOTENCY_APPLIED_TTL_MS,
                xx: true,
              });
              if (finalized !== "OK") {
                const fallbackFinalized = await kv.set(appliedKey, "applied", {
                  px: IDEMPOTENCY_APPLIED_TTL_MS,
                });
                isIdempotencyFinalized = fallbackFinalized === "OK";
              } else {
                isIdempotencyFinalized = true;
              }
            } catch (err) {
              posthog?.captureException(err, userId, {
                appliedKey,
                operation: "redis_finalize_idempotency",
                source: "polar_webhook",
              });
            }

            if (!isIdempotencyFinalized) {
              try {
                await kv.set(appliedKey, "pending", {
                  px: IDEMPOTENCY_APPLIED_TTL_MS,
                  xx: true,
                });
              } catch (err) {
                posthog?.captureException(err, userId, {
                  appliedKey,
                  operation: "redis_extend_pending_idempotency",
                  source: "polar_webhook",
                });
              }
            }

            void posthog?.shutdown();
            return new Response("ok");
          }

          void posthog?.shutdown();
          return new Response("ignored", { status: 200 });
        } catch (err) {
          posthog?.captureException(err, undefined, {
            eventType: payload?.type,
            source: "polar_webhook",
          });
          void posthog?.shutdown();
          const error = new Error("Polar webhook processing failed", { cause: err });
          throw error;
        }
      },
    },
  },
});
