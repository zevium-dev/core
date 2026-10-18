import { cycleBreakdown as readCycleBreakdown } from "./lib/billingRead";
import {
  financePage,
  FINANCE_PAGE_INTERVAL_MS,
  FINANCE_TRANSIENT_RETRY_MS,
  FINANCE_THROTTLE_RETRY_MS,
  isTransientFinanceError,
} from "./money/throughput";
import { v, ConvexError } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  internalAction,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import {
  paidFact,
  type PaidFact,
  stripeConfig,
  verifiedStripe,
  appOrigin,
} from "./lib/stripe";
import { grantLot } from "./money/lots";
import { ensureWallet } from "./money/walletLedger";
import { reconcilePaymentPage, reviewPayment } from "./money/adjustments";
const pack = v.union(
  v.literal("pack_10"),
  v.literal("pack_50"),
  v.literal("pack_100"),
);
export const CREDIT_PACKS = [
  { id: "pack_10", amount: 1000, credits: 100000 },
  { id: "pack_50", amount: 5000, credits: 500000 },
  { id: "pack_100", amount: 10000, credits: 1000000 },
] as const;
type PackId = (typeof CREDIT_PACKS)[number]["id"];
/**
 * Single pack quote for billing state and Checkout. Legal #318 gate: the fee is
 * off unless the owner enables it, configured per pack and never recalculated
 * against the actual charge. null means the pack is misconfigured (no credit
 * price, or an enabled fee without amount/price), so it cannot be sold.
 */
export function packQuote(packId: PackId) {
  const key = packId.toUpperCase();
  const creditPriceId = process.env[`NEXT_STRIPE_PRICE_${key}`];
  if (!creditPriceId) return null;
  const enabled = process.env.NEXT_CARD_FEE_ENABLED === "true";
  if (!enabled)
    return { creditPriceId, enabled, feeCents: 0, feeLinePriceId: undefined };
  const feeCents = Number(process.env[`NEXT_STRIPE_FEE_${key}_CENTS`]);
  const feeLinePriceId = process.env[`NEXT_STRIPE_FEE_${key}_PRICE`];
  if (!Number.isSafeInteger(feeCents) || feeCents <= 0 || !feeLinePriceId)
    return null;
  return { creditPriceId, enabled, feeCents, feeLinePriceId };
}
export const prepareCheckoutIntent = internalMutation({
  args: { packId: pack, customerId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    if (org.stripeCustomerId !== args.customerId)
      throw new ConvexError("Checkout customer mismatch");
    const selected = CREDIT_PACKS.find((p) => p.id === args.packId)!;
    const quote = packQuote(args.packId);
    if (!quote) throw new ConvexError("Credit pack unavailable");
    const {
      creditPriceId: stripeCreditPriceId,
      feeCents: fee,
      feeLinePriceId,
      enabled,
    } = quote;
    const now = Date.now();
    const id = await ctx.db.insert("checkoutIntents", {
      organizationId: org._id,
      packId: args.packId,
      credits: selected.credits,
      creditFaceValueCents: selected.amount,
      processingFeeQuotedCents: fee,
      totalCents: selected.amount + fee,
      currency: "usd",
      feePolicyVersion: enabled ? "estimated-v1" : "disabled-v1",
      feeQuoteExpiresAt: now + 3600000,
      stripeCreditPriceId,
      feeLinePriceId,
      stripeCustomerId: args.customerId,
      status: "pending",
      createdAt: now,
      expiresAt: now + 3600000,
    });
    return (await ctx.db.get(id))!;
  },
});
export const customerContext = internalQuery({
  args: {},
  handler: async (ctx) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    return { id: org._id, customerId: org.stripeCustomerId };
  },
});
export const setStripeCustomer = internalMutation({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    if (org.stripeCustomerId && org.stripeCustomerId !== args.customerId)
      throw new ConvexError("Customer identity conflict");
    await ctx.db.patch(org._id, { stripeCustomerId: args.customerId });
  },
});
export const attachCheckoutSession = internalMutation({
  args: { intentId: v.id("checkoutIntents"), sessionId: v.string() },
  handler: async (ctx, args) => {
    const i = await ctx.db.get(args.intentId);
    if (!i || (i.sessionId && i.sessionId !== args.sessionId))
      throw new ConvexError("Checkout identity conflict");
    await ctx.db.patch(i._id, {
      sessionId: args.sessionId,
      status: i.status === "paid" ? "paid" : "open",
    });
  },
});
class CheckoutPriceMismatch extends Error {
  constructor(
    readonly priceId: string,
    readonly check: string,
  ) {
    super("Stripe price does not match configured amount");
  }
}
export const createCheckout = action({
  args: { packId: pack },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; checkoutIntentId: Id<"checkoutIntents"> }> => {
    try {
      // Before any Stripe write: no return origin, no Checkout.
      const origin = appOrigin();
      const owner = await ctx.runQuery(internal.billing.customerContext, {}),
        stripe = await verifiedStripe();
      const customerId =
        owner.customerId ??
        (
          await stripe.customers.create(
            { metadata: { zevium_organization_id: owner.id } },
            { idempotencyKey: `next:customer:${owner.id}` },
          )
        ).id;
      await ctx.runMutation(internal.billing.setStripeCustomer, { customerId });
      const intent = await ctx.runMutation(
        internal.billing.prepareCheckoutIntent,
        { ...args, customerId },
      );
      // Paid webhook rejects any line that differs from the intent and grants
      // nothing, so a misconfigured env must fail here, before money moves.
      const lines = [
        [intent.stripeCreditPriceId, intent.creditFaceValueCents],
        ...(intent.feeLinePriceId
          ? [[intent.feeLinePriceId, intent.processingFeeQuotedCents] as const]
          : []),
      ] as const;
      const prices = await Promise.all(
        lines.map(([id]) => stripe.prices.retrieve(id)),
      );
      prices.forEach((p, i) => {
        const failed = !p.active
          ? "inactive"
          : p.type !== "one_time"
            ? "not one_time"
            : p.currency !== intent.currency
              ? "currency"
              : p.unit_amount !== lines[i]![1]
                ? "unit_amount"
                : null;
        if (failed) throw new CheckoutPriceMismatch(lines[i]![0], failed);
      });
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: customerId,
          adaptive_pricing: { enabled: false },
          ...(intent.feeLinePriceId
            ? {
                custom_text: {
                  submit: {
                    message:
                      "Estimated card fee is included. Your total will not change after payment.",
                  },
                },
              }
            : {}),
          line_items: [
            { price: intent.stripeCreditPriceId, quantity: 1 },
            ...(intent.feeLinePriceId
              ? [{ price: intent.feeLinePriceId, quantity: 1 }]
              : []),
          ],
          expires_at: Math.floor(intent.expiresAt / 1000),
          success_url: `${origin}/app/billing?checkout_session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/app/billing`,
          metadata: { checkoutIntentId: intent._id },
          payment_intent_data: { metadata: { checkoutIntentId: intent._id } },
        },
        { idempotencyKey: `next:checkout:${intent._id}` },
      );
      if (!session.url) throw new Error("Missing checkout URL");
      await ctx.runMutation(internal.billing.attachCheckoutSession, {
        intentId: intent._id,
        sessionId: session.id,
      });
      return { url: session.url, checkoutIntentId: intent._id };
    } catch (e) {
      // Ids and check names only: Stripe error bodies stay out of logs.
      console.error(
        "createCheckout failed",
        e instanceof CheckoutPriceMismatch
          ? { priceId: e.priceId, check: e.check }
          : e instanceof ConvexError
            ? { reason: String(e.data) }
            : { error: e instanceof Error ? e.name : "unknown" },
      );
      throw new ConvexError("Checkout is unavailable. Please try again.");
    }
  },
});
export async function projectPaid(ctx: MutationCtx, fact: PaidFact) {
  const intentId = ctx.db.normalizeId("checkoutIntents", fact.intentId),
    intent = intentId ? await ctx.db.get(intentId) : null;
  const config = stripeConfig();
  if (
    !intent ||
    fact.providerAccount !== config.account ||
    fact.livemode ||
    fact.customerId !== intent.stripeCustomerId ||
    (intent.sessionId && intent.sessionId !== fact.sessionId) ||
    fact.amountCents !== intent.totalCents ||
    fact.currency !== intent.currency
  )
    throw new ConvexError("Payment does not match Checkout");
  const expected = [
    {
      priceId: intent.stripeCreditPriceId,
      quantity: 1,
      amountCents: intent.creditFaceValueCents,
    },
    ...(intent.feeLinePriceId
      ? [
          {
            priceId: intent.feeLinePriceId,
            quantity: 1,
            amountCents: intent.processingFeeQuotedCents,
          },
        ]
      : []),
  ];
  if (
    fact.lines.length !== expected.length ||
    expected.some(
      (e) =>
        !fact.lines.some(
          (l) =>
            l.priceId === e.priceId &&
            l.quantity === 1 &&
            l.amountCents === e.amountCents,
        ),
    )
  )
    throw new ConvexError("Checkout price mismatch");
  const org = await ctx.db.get(intent.organizationId);
  if (!org) throw new ConvexError("Payment organization missing");
  const wallet = await ensureWallet(ctx, org);
  const prior = await ctx.db
    .query("payments")
    .withIndex("by_provider", (q) =>
      q
        .eq("rail", "stripe")
        .eq("providerAccount", config.account)
        .eq("providerPaymentRef", fact.paymentIntentId),
    )
    .unique();
  if (
    prior &&
    (prior.checkoutIntentId !== intentId ||
      prior.stripeChargeId !== fact.chargeId ||
      prior.amountPaidCents !== fact.amountCents ||
      prior.walletId !== wallet._id)
  )
    throw new ConvexError("Payment identity conflict");
  if (intent.paymentIntentId && intent.paymentIntentId !== fact.paymentIntentId)
    throw new ConvexError("Checkout already funded");
  const fee =
    fact.actualFeeCents === undefined
      ? {}
      : {
          processingFeeActualCents: fact.actualFeeCents,
          processingFeeVarianceCents:
            fact.actualFeeCents - intent.processingFeeQuotedCents,
        };
  const id = prior
    ? prior._id
    : await ctx.db.insert("payments", {
        walletId: wallet._id,
        rail: "stripe",
        providerPaymentRef: fact.paymentIntentId,
        checkoutIntentId: intent._id,
        stripeChargeId: fact.chargeId,
        providerAccount: config.account,
        livemode: false,
        currency: "usd",
        creditFaceValueCents: intent.creditFaceValueCents,
        processingFeeChargedCents: intent.processingFeeQuotedCents,
        ...fee,
        feePolicyVersion: intent.feePolicyVersion,
        refundFeePolicy: "full_paid_amount",
        amountPaidCents: intent.totalCents,
        credits: intent.credits,
        status: "paid",
        refundedCredits: 0,
        disputedCredits: 0,
        effectiveReversedCredits: 0,
        revision: 1,
        reconciliation: {
          state: "complete",
          targetCredits: 0,
          walletReversedCredits: 0,
          publisherTargetCredits: 0,
          generation: 0,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  if (prior && fact.actualFeeCents !== undefined) await ctx.db.patch(id, fee);
  await grantLot(ctx, {
    walletId: wallet._id,
    sourceRef: `stripe:${config.account}:${fact.paymentIntentId}`,
    sourceKind: "payment",
    paymentId: id,
    credits: intent.credits,
  });
  await ctx.db.patch(intent._id, {
    sessionId: fact.sessionId,
    paymentIntentId: fact.paymentIntentId,
    status: "paid",
  });
  return id;
}
export const projectPaidPayment = internalMutation({
  args: { json: v.string() },
  handler: (ctx, args) =>
    projectPaid(ctx, paidFact.parse(JSON.parse(args.json))),
});
export const checkoutIntent = internalQuery({
  args: { id: v.string() },
  handler: (ctx, args) => {
    const id = ctx.db.normalizeId("checkoutIntents", args.id);
    return id ? ctx.db.get(id) : null;
  },
});
export const paymentForCharge = internalQuery({
  args: { chargeId: v.string() },
  handler: (ctx, args) =>
    ctx.db
      .query("payments")
      .withIndex("by_charge", (q) => q.eq("stripeChargeId", args.chargeId))
      .unique(),
});
export const reconcilePage = internalMutation({
  args: { paymentId: v.id("payments"), generation: v.number() },
  handler: (ctx, args) =>
    financePage(ctx, (bounded) =>
      reconcilePaymentPage(bounded, args.paymentId, args.generation),
    ),
});
export const reconcile = internalAction({
  args: { paymentId: v.id("payments"), generation: v.number() },
  handler: async (ctx, args) => {
    try {
      const result = await ctx.runMutation(
        internal.billing.reconcilePage,
        args,
      );
      if (result === "more" || result === "throttled")
        await ctx.scheduler.runAfter(
          result === "throttled"
            ? FINANCE_THROTTLE_RETRY_MS
            : FINANCE_PAGE_INTERVAL_MS,
          internal.billing.reconcile,
          args,
        );
    } catch (error) {
      if (isTransientFinanceError(error)) {
        // If scheduling also fails, the committed recovery deadline remains due.
        await ctx.scheduler.runAfter(
          FINANCE_TRANSIENT_RETRY_MS,
          internal.billing.reconcile,
          args,
        );
        return;
      }
      await ctx.runMutation(internal.billing.reconcileFailure, args);
    }
  },
});
export const reconcileFailure = internalMutation({
  args: { paymentId: v.id("payments"), generation: v.number() },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (
      !p ||
      p.reconciliation.generation !== args.generation ||
      p.reconciliation.state === "complete" ||
      p.reconciliation.state === "needs_review"
    )
      return;
    const attempts = (p.reconciliation.attempts ?? 0) + 1;
    if (attempts >= 8) return reviewPayment(ctx, p, attempts);
    await ctx.db.patch(p._id, {
      reconciliation: {
        ...p.reconciliation,
        attempts,
        state: "retry",
        nextAttemptAt: Date.now() + 60_000,
      },
    });
  },
});
export const recoverAdjustments = internalMutation({
  args: {},
  handler: async (ctx) => {
    let delay = 0;
    for (const state of [
      "pending",
      "retry",
      "processing",
      "needs_review",
    ] as const) {
      const rows = await ctx.db
        .query("payments")
        .withIndex("by_reconcile", (q) =>
          q
            .eq("reconciliation.state", state)
            .gt("reconciliation.nextAttemptAt", 0)
            .lte("reconciliation.nextAttemptAt", Date.now()),
        )
        .take(25);
      for (const p of rows) {
        await ctx.db.patch(p._id, {
          reconciliation: {
            ...p.reconciliation,
            nextAttemptAt: Date.now() + 60000,
          },
        });
        await ctx.scheduler.runAfter(delay, internal.billing.reconcile, {
          paymentId: p._id,
          generation: p.reconciliation.generation,
        });
        delay += FINANCE_PAGE_INTERVAL_MS;
      }
    }
  },
});
export const getBillingState = query({
  args: {
    checkoutSessionId: v.optional(v.string()),
    checkoutIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { org, access } = await requireActiveOrg(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${org.clerkOrgId}`))
      .unique();
    const payments =
      wallet && access.capabilities.manageBilling
        ? await ctx.db
            .query("payments")
            .withIndex("by_wallet_time", (q) => q.eq("walletId", wallet._id))
            .order("desc")
            .take(50)
        : [];
    let checkout = null;
    if (access.capabilities.manageBilling) {
      const id = args.checkoutIntentId
        ? ctx.db.normalizeId("checkoutIntents", args.checkoutIntentId)
        : null;
      const intent = args.checkoutSessionId
        ? await ctx.db
            .query("checkoutIntents")
            .withIndex("by_session", (q) =>
              q.eq("sessionId", args.checkoutSessionId!),
            )
            .unique()
        : id
          ? await ctx.db.get(id)
          : null;
      if (intent?.organizationId === org._id)
        checkout = {
          id: intent._id,
          status: intent.status === "paid" ? "complete" : intent.status,
        };
    }
    return {
      access,
      wallet: {
        balance: wallet?.balance ?? 0,
        lockedCredits: wallet?.lockedCredits ?? 0,
      },
      packs: access.capabilities.manageBilling
        ? CREDIT_PACKS.map((p) => {
            const feeCents = packQuote(p.id)?.feeCents;
            return {
              packId: p.id,
              priceCents: p.amount,
              credits: p.credits,
              available: feeCents !== undefined,
              feeCents: feeCents ?? 0,
              totalCents: p.amount + (feeCents ?? 0),
            };
          })
        : [],
      checkout,
      payments: payments.map((p) => ({
        id: p._id,
        status: p.status,
        amount: p.amountPaidCents,
        currency: p.currency,
        credits: p.credits,
        refundedCredits: p.refundedCredits,
        createdAt: p.createdAt,
        creditFaceValueCents: p.creditFaceValueCents,
        processingFeeChargedCents: p.processingFeeChargedCents,
      })),
    };
  },
});

export const cycleBreakdown = query({
  args: { orgSlug: v.string() },
  handler: readCycleBreakdown,
});
