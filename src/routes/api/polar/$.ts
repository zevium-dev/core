import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";

import { serverEnv } from "~/env/server";
import { addCreditsTopUp } from "~/lib/server/credits";

/**
 * Polar API routes
 * - POST /api/polar/webhook -> webhook handler
 */
export const Route = createFileRoute("/api/polar/$" as any)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/webhook")) {
          const payload = (await request.json()) as any;
          try {
            const type: string = payload?.type ?? payload?.event ?? "";
            const data = payload?.data ?? payload;
            const productId = data?.productId ?? data?.product_id ?? data?.product?.id;
            const status = data?.status ?? data?.charge?.status ?? data?.checkout?.status;
            const metadata = data?.metadata ?? data?.checkout?.metadata ?? {};
            const userId: string | undefined = metadata.userId ?? metadata.user_id;
            const amountCents: number =
              data?.amountCents ?? data?.amount_cents ?? data?.subtotal_amount ?? data?.amount ?? 0;

            const succeeded =
              ["payment.succeeded", "checkout.succeeded", "order.paid", "charge.succeeded"].includes(type) ||
              ["succeeded", "paid"].includes(String(status));

            const isCreditsProduct = productId === serverEnv.POLAR_PRODUCT_ID_CREDITS;

            if (succeeded && isCreditsProduct && userId && amountCents > 0) {
              await addCreditsTopUp(userId, Number(amountCents), data?.id ?? randomUUID(), "Polar top-up");
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


