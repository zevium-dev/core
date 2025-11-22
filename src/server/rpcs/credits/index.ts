import { z } from "zod";
import { Polar } from "@polar-sh/sdk";

import { serverEnv } from "~/env/server";
import { addCreditsTopUp, getUserBalanceCents } from "~/lib/server/credits";
import { protectedProcedure, router } from "~/server/trpc";

const polarClient = new Polar({
  accessToken: serverEnv.POLAR_ACCESS_TOKEN,
  server: serverEnv.POLAR_SERVER,
});

export const creditsRouter = router({
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const cents = await getUserBalanceCents(ctx.user.id);
    return { balanceCents: cents, currency: "usd" as const };
  }),
  createTopUpCheckout: protectedProcedure
    .input(
      z.object({
        // amount in USD cents
        amountCents: z.number().int().positive().max(100_000_00),
        // optional metadata
        returnUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const origin = new URL(ctx.raw.req.url).origin;
      const successUrl = input.returnUrl ?? new URL("/app/settings/credits", origin).toString();

      // Use custom price for arbitrary top-up amounts
      const productId = serverEnv.POLAR_PRODUCT_ID_CREDITS;
      const checkout = await polarClient.checkouts.create({
        products: [productId],
        prices: {
          [productId]: [
            {
              amountType: "custom",
              priceCurrency: "usd",
              presetAmount: input.amountCents,
            },
          ],
        },
        successUrl,
        metadata: { userId: ctx.user.id, type: "credit-topup" },
      });
      return { url: (checkout as unknown as { url?: string }).url ?? successUrl };
    }),
});


