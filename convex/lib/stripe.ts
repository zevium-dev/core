import Stripe from "stripe";
import { z } from "zod";
import { ConvexError } from "convex/values";
import { configuredAppOrigin } from "./appOrigin";
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;
/** Payments remain test-mode only. Live-mode activation requires separate owner approval. */
export function stripeConfig() {
  const key = process.env.NEXT_STRIPE_SECRET_KEY;
  const account = process.env.NEXT_STRIPE_PLATFORM_ACCOUNT_ID;
  if (!key || !/^(sk|rk)_test_/.test(key) || !account?.startsWith("acct_"))
    throw new Error("Stripe sandbox is not configured");
  return { key, account, livemode: false as const };
}
export function stripeClient() {
  return new Stripe(stripeConfig().key, {
    // SDK v23 types describe Endive; keep our tested Dahlia wire contract.
    // @ts-expect-error Intentional older Stripe API version.
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 0,
    timeout: 15_000,
    httpClient: Stripe.createFetchHttpClient(),
  });
}
export async function verifiedStripe() {
  const stripe = stripeClient(),
    config = stripeConfig();
  const [account, balance] = await Promise.all([
    stripe.accounts.retrieve(null),
    stripe.balance.retrieve(),
  ]);
  if (
    account.id !== config.account ||
    balance.livemode ||
    account.default_currency !== "usd"
  )
    throw new Error("Stripe platform identity mismatch");
  return stripe;
}
export const providerId = (
  value: string | { id: string } | null | undefined,
) => (typeof value === "string" ? value : value?.id);
export const cents = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const id = z.string().min(1).max(200);
export const paidFact = z
  .object({
    intentId: id,
    sessionId: id,
    paymentIntentId: id,
    chargeId: id,
    customerId: id,
    currency: z.literal("usd"),
    livemode: z.literal(false),
    providerAccount: id,
    amountCents: cents,
    actualFeeCents: cents.optional(),
    lines: z
      .array(
        z.object({ priceId: id, quantity: z.literal(1), amountCents: cents }),
      )
      .max(2),
  })
  .strict();
export type PaidFact = z.infer<typeof paidFact>;
/** Checkout/Connect return origin; refuses rather than guessing one. */
export function appOrigin() {
  const origin = configuredAppOrigin("NEXT_APP_ORIGIN");
  if (!origin)
    throw new ConvexError(
      "Payments are unavailable right now. Please try again later.",
    );
  return origin;
}
export function definitiveStripeFailure(error: unknown) {
  // Executed 5xx/network requests may have succeeded. Never release those allocations.
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError ||
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  );
}
