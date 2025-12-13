import { z } from "zod";
import { Polar } from "@polar-sh/sdk";

import { serverEnv } from "~/env/server";
import { addCreditsTopUp, getUserBalanceCents } from "~/lib/server/credits";
import { protectedProcedure, router } from "~/server/trpc";
import { db, schema, orm } from "~/db";

const polarClient = new Polar({
  accessToken: serverEnv.POLAR_ACCESS_TOKEN,
  server: serverEnv.POLAR_SERVER,
});

export const creditsRouter = router({
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const cents = await getUserBalanceCents(ctx.user.id);
    return { balanceCents: cents, currency: "usd" as const };
  }),
  getInvoiceUrl: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const invoice = await polarClient.orders.invoice({ id: input.orderId });
      return { url: invoice.url };
    }),
  listTransactions: protectedProcedure
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(50).default(3),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Pull from Polar orders by metadata userId and the credits product
      const page = await polarClient.orders.list({
        customerId: null, // we're relying on metadata to avoid any customer mismatch
        limit: input.pageSize,
        metadata: { userId: ctx.user.id },
        page: input.page,
        productId: serverEnv.POLAR_PRODUCT_ID_CREDITS,
        sorting: ["-created_at"],
      });

      const items = page.result.items.map((o) => ({
        id: o.id,
        userId: ctx.user.id,
        amountCents: o.totalAmount,
        type: "topup" as const,
        reference: o.id,
        description: "Polar top-up",
        createdAt: o.createdAt,
      }));
      const hasNext = input.page < page.result.pagination.maxPage;
      return { items, hasNext };
    }),
  createTopUpCheckout: protectedProcedure
    .input(
      z.object({
        // amount in USD cents
        amountCents: z.number().int().positive().max(100_000_00),
        // optional metadata
        returnUrl: z.url().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const origin = new URL(ctx.raw.req.url).origin;
      // Always redirect to a waiting page that ensures order.paid has been processed
      const successUrl =
        input.returnUrl ??
        new URL("/app/settings/credits/success?checkout_id={CHECKOUT_ID}", origin).toString();

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
  getTopUpFromCheckout: protectedProcedure
    .input(z.object({ checkoutId: z.string() }))
    .query(async ({ input }) => {
      const page = await polarClient.orders.list({
        checkoutId: input.checkoutId,
        limit: 1,
        productId: serverEnv.POLAR_PRODUCT_ID_CREDITS,
        sorting: ["-created_at"],
      });
      const order = page.result.items.at(0);
      if (!order) return { amountCents: 0, orderId: null as string | null };
      return { amountCents: order.totalAmount, orderId: order.id };
    }),
  awaitCreditApplied: protectedProcedure
    .input(z.object({ checkoutId: z.string() }))
    .query(async ({ input, ctx }) => {
      const { kv } = await import("~/lib/server/kv");
      const key = `polar:credit_applied:${ctx.user.id}:${input.checkoutId}`;
      const applied = await kv.get<string>(key);
      return { applied: Boolean(applied) };
    }),
});


