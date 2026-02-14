import { z } from "zod";

import { serverEnv } from "~/env/server";
import { CreditsManager } from "~/lib/server/credits";
import { polarClient } from "~/lib/server/polar";
import { protectedProcedure, router } from "~/server/trpc";

const transactionItemSchema = z.object({
  amountCents: z.number().int(),
  createdAt: z.union([z.string(), z.date()]),
  description: z.string().nullable(),
  id: z.string(),
  reference: z.string().nullable(),
  type: z.literal("topup"),
  userId: z.string(),
});

export const creditsRouter = router({
  createTopUpCheckout: protectedProcedure
    .input(
      z.object({
        // amount in USD cents
        amountCents: z.number().int().positive().max(100_000_00),
        // optional metadata
        returnUrl: z.url().optional(),
      }),
    )
    .output(z.object({ url: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const origin = new URL(ctx.raw.req.url).origin;
      // Always redirect to a waiting page that ensures order.paid has been processed
      const successUrl =
        input.returnUrl ?? new URL("/app/settings/credits/success?checkout_id={CHECKOUT_ID}", origin).toString();

      // Use custom price for arbitrary top-up amounts
      const productId = serverEnv.POLAR_PRODUCT_ID_CREDITS;
      const checkout = await polarClient.checkouts.create({
        metadata: { type: "credit-topup", userId: ctx.user.id },
        prices: {
          [productId]: [
            {
              amountType: "custom",
              presetAmount: input.amountCents,
              priceCurrency: "usd",
            },
          ],
        },
        products: [productId],
        successUrl,
      });
      return { url: typeof checkout.url === "string" ? checkout.url : successUrl };
    }),
  getBalance: protectedProcedure
    .output(
      z.object({
        balanceCents: z.number().int().nonnegative(),
        currency: z.literal("usd"),
      }),
    )
    .query(async ({ ctx }) => {
      const cents = await CreditsManager.getBalance(ctx.user.id);
      return { balanceCents: cents, currency: "usd" as const };
    }),
  getInvoiceUrl: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .output(z.object({ url: z.string() }))
    .query(async ({ input }) => {
      const invoice = await polarClient.orders.invoice({ id: input.orderId });
      return { url: invoice.url };
    }),
  getTopUpFromCheckout: protectedProcedure
    .input(z.object({ checkoutId: z.string() }))
    .output(
      z.object({
        amountCents: z.number().int().nonnegative(),
        orderId: z.string().nullable(),
      }),
    )
    .query(async ({ input }) => {
      const page = await polarClient.orders.list({
        checkoutId: input.checkoutId,
        limit: 1,
        productId: serverEnv.POLAR_PRODUCT_ID_CREDITS,
        sorting: ["-created_at"],
      });
      const order = page.result.items.at(0);
      if (!order) return { amountCents: 0, orderId: null as null | string };
      return { amountCents: order.subtotalAmount, orderId: order.id };
    }),
  listTransactions: protectedProcedure
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(50).default(3),
      }),
    )
    .output(
      z.object({
        hasNext: z.boolean(),
        items: z.array(transactionItemSchema),
      }),
    )
    .query(async ({ ctx, input }) => {
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
        amountCents: o.subtotalAmount,
        createdAt: o.createdAt,
        description: "Polar top-up",
        id: o.id,
        reference: o.id,
        type: "topup" as const,
        userId: ctx.user.id,
      }));
      const hasNext = input.page < page.result.pagination.maxPage;
      return { hasNext, items };
    }),
});
