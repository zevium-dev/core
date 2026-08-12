import Stripe from "stripe";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireOrgMemberBySlug } from "./lib/auth";
import { reconcilePaymentPublisherClawback } from "./lib/publisherLedger";
import { appendWalletEntry, getOrCreateWallet } from "./wallets";

/** Pinned alongside `stripe@22.3.1`; upgrade only as an explicit migration. */
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;

export type CreditPackId = "pack_10" | "pack_50" | "pack_100";

export type CreditPackDefinition = {
  packId: CreditPackId;
  name: string;
  description: string;
  priceCents: number;
  credits: number;
};

/** Server-owned catalogue. Price IDs come only from process configuration. */
export const CREDIT_PACKS: readonly CreditPackDefinition[] = [
  {
    packId: "pack_10",
    name: "Zevium Credits — $10",
    description: "100,000 credits",
    priceCents: 1_000,
    credits: 100_000,
  },
  {
    packId: "pack_50",
    name: "Zevium Credits — $50",
    description: "500,000 credits",
    priceCents: 5_000,
    credits: 500_000,
  },
  {
    packId: "pack_100",
    name: "Zevium Credits — $100",
    description: "1,000,000 credits",
    priceCents: 10_000,
    credits: 1_000_000,
  },
] as const;

export type PublicCreditPack = CreditPackDefinition;

export function creditPack(packId: CreditPackId): CreditPackDefinition {
  const pack = CREDIT_PACKS.find((candidate) => candidate.packId === packId);
  if (pack === undefined) throw new Error("Unknown credit pack");
  return pack;
}

export function stripePriceForPack(packId: CreditPackId): string {
  const name =
    packId === "pack_10"
      ? "STRIPE_PRICE_PACK_10"
      : packId === "pack_50"
        ? "STRIPE_PRICE_PACK_50"
        : "STRIPE_PRICE_PACK_100";
  const priceId = process.env[name];
  if (priceId === undefined || priceId.trim() === "") {
    throw new Error(`${name} is not configured`);
  }
  return priceId;
}

/** Cumulative proportional reversal, capped to the original immutable grant. */
export function cumulativeRefundCredits(args: {
  grantedCredits: number;
  reversedCredits: number;
  paidAmount: number;
  totalRefundedAmount: number;
}): { targetReversedCredits: number; creditsToReverse: number } {
  if (
    !Number.isSafeInteger(args.grantedCredits) ||
    !Number.isSafeInteger(args.reversedCredits) ||
    !Number.isSafeInteger(args.paidAmount) ||
    !Number.isSafeInteger(args.totalRefundedAmount) ||
    args.grantedCredits < 0 ||
    args.reversedCredits < 0 ||
    args.paidAmount <= 0 ||
    args.totalRefundedAmount < 0
  ) {
    throw new Error("Invalid immutable payment or refund amount");
  }
  const targetReversedCredits = Math.min(
    args.grantedCredits,
    Math.floor(
      (args.grantedCredits *
        Math.min(args.totalRefundedAmount, args.paidAmount)) /
        args.paidAmount,
    ),
  );
  return {
    targetReversedCredits,
    creditsToReverse: Math.max(0, targetReversedCredits - args.reversedCredits),
  };
}

function appOrigin(): string {
  const raw = process.env.APP_ORIGIN;
  if (raw === undefined || raw.trim() === "") {
    throw new Error("APP_ORIGIN is not configured");
  }
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
    throw new Error("APP_ORIGIN must use HTTPS outside localhost");
  }
  return origin.origin;
}

export function stripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (secretKey === undefined || secretKey.trim() === "") {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}

function stringId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (typeof value === "string") return value;
  if (value !== null && value !== undefined && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function activeClerkOrgId(identity: unknown): string {
  if (identity === null || typeof identity !== "object") {
    throw new Error("Not authenticated");
  }
  const raw = identity as Record<string, unknown>;
  const orgId =
    typeof raw.org_id === "string"
      ? raw.org_id
      : typeof raw.orgId === "string"
        ? raw.orgId
        : undefined;
  if (orgId === undefined || orgId.trim() === "") {
    throw new Error("Active organization required");
  }
  return orgId;
}

async function requireActiveClerkOrgInAction(ctx: ActionCtx): Promise<string> {
  return activeClerkOrgId(await ctx.auth.getUserIdentity());
}

export type StripeCheckoutCreator = {
  checkout: {
    sessions: {
      create: (
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ) => Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;
    };
  };
};

/** Isolated external call: tests can pass a deterministic Stripe double. */
export async function createHostedCheckout(
  stripe: StripeCheckoutCreator,
  args: {
    stripeCustomerId: string;
    stripePriceId: string;
    checkoutIntentId: string;
    clerkOrgId: string;
    packId: CreditPackId;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ id: string; url: string }> {
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      adaptive_pricing: { enabled: false },
      customer: args.stripeCustomerId,
      line_items: [{ price: args.stripePriceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: {
        checkoutIntentId: args.checkoutIntentId,
        clerkOrgId: args.clerkOrgId,
        packId: args.packId,
      },
      payment_intent_data: {
        metadata: { checkoutIntentId: args.checkoutIntentId },
      },
    },
    { idempotencyKey: `checkout:${args.checkoutIntentId}` },
  );
  if (session.url === null || session.url.trim() === "") {
    throw new Error("Stripe Checkout did not return a hosted URL");
  }
  return { id: session.id, url: session.url };
}

export const listPacksStatic = query({
  args: {},
  handler: async (): Promise<PublicCreditPack[]> => [...CREDIT_PACKS],
});

export const prepareCheckoutIntent = internalMutation({
  args: {
    clerkOrgId: v.string(),
    packId: v.union(
      v.literal("pack_10"),
      v.literal("pack_50"),
      v.literal("pack_100"),
    ),
    stripePriceId: v.string(),
  },
  handler: async (ctx, args) => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (organization === null)
      throw new Error("Active organization is not provisioned");
    const pack = creditPack(args.packId);
    const now = Date.now();
    const checkoutIntentId = await ctx.db.insert("checkoutIntents", {
      organizationId: organization._id,
      packId: pack.packId,
      stripePriceId: args.stripePriceId,
      amount: pack.priceCents,
      currency: "usd",
      credits: pack.credits,
      status: "created",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 30 * 60 * 1000,
    });
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .unique();
    if (profile === null) {
      await ctx.db.insert("organizationPayments", {
        organizationId: organization._id,
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: [],
        updatedAt: now,
      });
    }
    return {
      checkoutIntentId,
      organizationId: organization._id,
      organizationName: organization.name,
      stripeCustomerId: profile?.stripeCustomerId ?? null,
    };
  },
});

export const setStripeCustomer = internalMutation({
  args: {
    checkoutIntentId: v.id("checkoutIntents"),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    const intent = await ctx.db.get(args.checkoutIntentId);
    if (intent === null) throw new Error("Checkout intent not found");
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", intent.organizationId),
      )
      .unique();
    if (profile === null) throw new Error("Payment profile not found");
    if (
      profile.stripeCustomerId !== undefined &&
      profile.stripeCustomerId !== args.stripeCustomerId
    ) {
      return profile.stripeCustomerId;
    }
    await ctx.db.patch(profile._id, {
      stripeCustomerId: args.stripeCustomerId,
      updatedAt: Date.now(),
    });
    return args.stripeCustomerId;
  },
});

export const attachCheckoutSession = internalMutation({
  args: {
    checkoutIntentId: v.id("checkoutIntents"),
    stripeCheckoutSessionId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const intent = await ctx.db.get(args.checkoutIntentId);
    if (intent === null) throw new Error("Checkout intent not found");
    if (
      intent.stripeCheckoutSessionId !== undefined &&
      intent.stripeCheckoutSessionId !== args.stripeCheckoutSessionId
    ) {
      throw new Error("Checkout intent already has a different Stripe session");
    }
    await ctx.db.patch(intent._id, {
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      status: "open",
      updatedAt: Date.now(),
    });
  },
});

export const createCheckout = action({
  args: {
    packId: v.union(
      v.literal("pack_10"),
      v.literal("pack_50"),
      v.literal("pack_100"),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; checkoutIntentId: Id<"checkoutIntents"> }> => {
    const clerkOrgId = await requireActiveClerkOrgInAction(ctx);
    const stripePriceId = stripePriceForPack(args.packId);
    const prepared = await ctx.runMutation(
      internal.billing.prepareCheckoutIntent,
      {
        clerkOrgId,
        packId: args.packId,
        stripePriceId,
      },
    );
    const stripe = stripeClient();
    let stripeCustomerId = prepared.stripeCustomerId;
    if (stripeCustomerId === null) {
      const customer = await stripe.customers.create(
        {
          name: prepared.organizationName,
          metadata: { clerkOrgId },
        },
        { idempotencyKey: `customer:${prepared.organizationId}` },
      );
      stripeCustomerId = await ctx.runMutation(
        internal.billing.setStripeCustomer,
        {
          checkoutIntentId: prepared.checkoutIntentId,
          stripeCustomerId: customer.id,
        },
      );
    }
    const origin = appOrigin();
    const hosted = await createHostedCheckout(stripe, {
      stripeCustomerId,
      stripePriceId,
      checkoutIntentId: prepared.checkoutIntentId,
      clerkOrgId,
      packId: args.packId,
      successUrl: `${origin}/app/billing?checkout={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/app/billing`,
    });
    await ctx.runMutation(internal.billing.attachCheckoutSession, {
      checkoutIntentId: prepared.checkoutIntentId,
      stripeCheckoutSessionId: hosted.id,
    });
    return { url: hosted.url, checkoutIntentId: prepared.checkoutIntentId };
  },
});

export const STRIPE_EVENT_MAX_ATTEMPTS = 8;
const STRIPE_EVENT_LEASE_MS = 5 * 60 * 1000;
const STRIPE_RETRY_DELAYS_MS = [
  1_000,
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

function stripeRetryDelay(attempts: number): number {
  return STRIPE_RETRY_DELAYS_MS[
    Math.min(Math.max(attempts - 1, 0), STRIPE_RETRY_DELAYS_MS.length - 1)
  ];
}

export const receiveStripeEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    stripeAccount: v.string(),
    eventType: v.string(),
    objectId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ isNew: boolean; scheduled: boolean }> => {
    if (
      args.stripeEventId.trim() === "" ||
      args.stripeAccount.trim() === "" ||
      args.eventType.trim() === "" ||
      args.objectId.trim() === ""
    ) {
      throw new Error("Stripe event identifiers are required");
    }
    const existing = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.stripeAccount !== args.stripeAccount ||
        existing.eventType !== args.eventType ||
        existing.objectId !== args.objectId
      ) {
        throw new Error("Stripe event id was redelivered with different data");
      }
      const now = Date.now();
      await ctx.db.patch(existing._id, {
        deliveries: existing.deliveries + 1,
      });
      const retryable = existing.status === "failed";
      const abandonedLease =
        existing.status === "processing" &&
        existing.attempts < STRIPE_EVENT_MAX_ATTEMPTS &&
        (existing.leaseExpiresAt ?? 0) <= now;
      if (retryable || abandonedLease) {
        await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
          stripeEventId: args.stripeEventId,
        });
        await ctx.db.patch(existing._id, {
          status: "received",
          attempts:
            retryable && existing.attempts >= STRIPE_EVENT_MAX_ATTEMPTS
              ? 0
              : existing.attempts,
          nextAttemptAt: undefined,
          leaseExpiresAt: undefined,
        });
        return { isNew: false, scheduled: true };
      }
      if (
        existing.status === "processing" &&
        existing.attempts >= STRIPE_EVENT_MAX_ATTEMPTS &&
        (existing.leaseExpiresAt ?? 0) <= now
      ) {
        await ctx.db.patch(existing._id, {
          status: "failed",
          lastError: "Stripe event processing lease expired at retry limit",
          leaseExpiresAt: undefined,
        });
      }
      return { isNew: false, scheduled: false };
    }
    const now = Date.now();
    await ctx.db.insert("paymentEvents", {
      stripeEventId: args.stripeEventId,
      stripeAccount: args.stripeAccount,
      eventType: args.eventType,
      objectId: args.objectId,
      status: "received",
      attempts: 0,
      deliveries: 1,
      receivedAt: now,
    });
    // Scheduler write commits atomically with receipt. Returning 200 now means
    // event is durably queued, not merely stored and forgotten.
    await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
      stripeEventId: args.stripeEventId,
    });
    return { isNew: true, scheduled: true };
  },
});

export const claimStripeEvent = internalMutation({
  args: { stripeEventId: v.string() },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (event === null) return null;
    const now = Date.now();
    if (event.status === "processed" || event.status === "ignored") return null;
    if (event.attempts >= STRIPE_EVENT_MAX_ATTEMPTS) return null;
    if (event.status === "processing" && (event.leaseExpiresAt ?? 0) > now) {
      return null;
    }
    if (
      event.status === "failed" &&
      (event.attempts >= STRIPE_EVENT_MAX_ATTEMPTS ||
        (event.nextAttemptAt ?? 0) > now)
    ) {
      return null;
    }
    await ctx.db.patch(event._id, {
      status: "processing",
      attempts: event.attempts + 1,
      nextAttemptAt: undefined,
      leaseExpiresAt: now + STRIPE_EVENT_LEASE_MS,
      lastError: undefined,
    });
    return {
      stripeEventId: event.stripeEventId,
      stripeAccount: event.stripeAccount,
      eventType: event.eventType,
      objectId: event.objectId,
    };
  },
});

export const finishStripeEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    status: v.union(v.literal("processed"), v.literal("ignored")),
  },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (event === null) return;
    if (event.status === "processed" || event.status === "ignored") return;
    await ctx.db.patch(event._id, {
      status: args.status,
      lastError: undefined,
      nextAttemptAt: undefined,
      leaseExpiresAt: undefined,
      processedAt: Date.now(),
    });
  },
});

export const failStripeEvent = internalMutation({
  args: { stripeEventId: v.string(), error: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (
      event === null ||
      event.status === "processed" ||
      event.status === "ignored"
    ) {
      return;
    }
    const retry = event.attempts < STRIPE_EVENT_MAX_ATTEMPTS;
    const delay = stripeRetryDelay(event.attempts);
    const nextAttemptAt = retry ? Date.now() + delay : undefined;
    await ctx.db.patch(event._id, {
      status: "failed",
      lastError: args.error.slice(0, 240),
      nextAttemptAt,
      leaseExpiresAt: undefined,
    });
    if (retry) {
      await ctx.scheduler.runAfter(delay, internal.billing.processStripeEvent, {
        stripeEventId: event.stripeEventId,
      });
    }
  },
});

/** Recovery net for an action killed after claiming but before scheduling retry. */
export const recoverStripeEvents = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const failed = await ctx.db
      .query("paymentEvents")
      .withIndex("by_status_next_attempt", (q) => q.eq("status", "failed"))
      .filter((q) => q.lte(q.field("nextAttemptAt"), now))
      .take(100);
    const expired = await ctx.db
      .query("paymentEvents")
      .withIndex("by_status_lease", (q) => q.eq("status", "processing"))
      .filter((q) => q.lte(q.field("leaseExpiresAt"), now))
      .take(100);
    let scheduled = 0;
    for (const event of [...failed, ...expired]) {
      if (event.attempts >= STRIPE_EVENT_MAX_ATTEMPTS) {
        if (event.status === "processing") {
          await ctx.db.patch(event._id, {
            status: "failed",
            lastError: "Stripe event processing lease expired at retry limit",
            leaseExpiresAt: undefined,
          });
        }
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
        stripeEventId: event.stripeEventId,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});

/**
 * Upserts the Stripe payment projection after all immutable, server-owned
 * checkout facts have been checked. It intentionally does not credit wallets.
 */
export const upsertPaidPayment = internalMutation({
  args: {
    stripeCheckoutSessionId: v.string(),
    stripePaymentIntentId: v.string(),
    stripeChargeId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db
      .query("checkoutIntents")
      .withIndex("by_checkout_session", (q) =>
        q.eq("stripeCheckoutSessionId", args.stripeCheckoutSessionId),
      )
      .unique();
    if (intent === null) throw new Error("Unknown checkout session");
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", intent.organizationId),
      )
      .unique();
    if (profile === null || profile.stripeCustomerId === undefined) {
      throw new Error("Checkout organization has no Stripe customer");
    }
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_payment_intent", (q) =>
        q.eq("stripePaymentIntentId", args.stripePaymentIntentId),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (existing.organizationId !== intent.organizationId) {
        throw new Error("Payment intent belongs to another organization");
      }
      await ctx.db.patch(existing._id, {
        stripeChargeId: args.stripeChargeId ?? existing.stripeChargeId,
        status: existing.status === "pending" ? "paid" : existing.status,
        updatedAt: now,
      });
      return {
        paymentId: existing._id,
        organizationId: intent.organizationId,
        credits: intent.credits,
      };
    }
    const paymentId = await ctx.db.insert("payments", {
      organizationId: intent.organizationId,
      checkoutIntentId: intent._id,
      stripeCheckoutSessionId: args.stripeCheckoutSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripeChargeId: args.stripeChargeId,
      amount: intent.amount,
      currency: intent.currency,
      grantedCredits: intent.credits,
      refundedAmount: 0,
      refundedCredits: 0,
      reversedCredits: 0,
      publisherClawbackTargetCredits: 0,
      status: "paid",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(intent._id, {
      stripePaymentIntentId: args.stripePaymentIntentId,
      status: "complete",
      updatedAt: now,
    });
    return {
      paymentId,
      organizationId: intent.organizationId,
      credits: intent.credits,
    };
  },
});

export const markPaymentGrantRecorded = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args): Promise<void> => {
    const payment = await ctx.db.get(args.paymentId);
    if (payment === null) throw new Error("Payment not found");
    if (payment.status === "pending") {
      await ctx.db.patch(payment._id, {
        status: "paid",
        updatedAt: Date.now(),
      });
    }
  },
});

const stripeDisputeStatus = v.union(
  v.literal("warning_needs_response"),
  v.literal("warning_under_review"),
  v.literal("warning_closed"),
  v.literal("needs_response"),
  v.literal("under_review"),
  v.literal("won"),
  v.literal("lost"),
  v.literal("prevented"),
);

const stripeDisputeMovement = v.union(
  v.literal("none"),
  v.literal("funds_withdrawn"),
  v.literal("funds_reinstated"),
);

function terminalDisputeStatus(
  status: Doc<"paymentDisputes">["status"],
): boolean {
  return (
    status === "warning_closed" ||
    status === "won" ||
    status === "lost" ||
    status === "prevented"
  );
}

function paymentStatusForProjection(args: {
  grantedCredits: number;
  refundedCredits: number;
  disputes: Doc<"paymentDisputes">[];
}): Doc<"payments">["status"] {
  const moneyOutstanding = args.disputes.filter(
    (dispute) => dispute.fundsWithdrawn && !dispute.fundsReinstated,
  );
  const open = args.disputes.some(
    (dispute) => !terminalDisputeStatus(dispute.status),
  );
  if (open || moneyOutstanding.some((dispute) => dispute.status !== "lost")) {
    return "disputed";
  }
  if (moneyOutstanding.length > 0) return "dispute_lost";
  if (args.refundedCredits === args.grantedCredits) return "refunded";
  if (args.refundedCredits > 0) return "partially_refunded";
  if (args.disputes.some((dispute) => dispute.status === "lost")) {
    return "dispute_lost";
  }
  if (
    args.disputes.some(
      (dispute) => dispute.status === "won" || dispute.status === "prevented",
    )
  ) {
    return "dispute_won";
  }
  return "paid";
}

async function applyEffectivePaymentReversal(
  ctx: MutationCtx,
  args: {
    payment: Doc<"payments">;
    refundedAmount: number;
    refundedCredits: number;
    disputes: Doc<"paymentDisputes">[];
    sourceKind: "refund" | "dispute";
    sourceRef: string;
  },
): Promise<{ walletDelta: number; targetReversedCredits: number }> {
  const disputedCredits = args.disputes.reduce(
    (sum, dispute) =>
      sum +
      (dispute.fundsWithdrawn && !dispute.fundsReinstated
        ? dispute.creditsAtRisk
        : 0),
    0,
  );
  const targetReversedCredits = Math.min(
    args.payment.grantedCredits,
    args.refundedCredits + disputedCredits,
  );
  const walletDelta = targetReversedCredits - args.payment.reversedCredits;
  if (walletDelta !== 0) {
    const wallet = await getOrCreateWallet(ctx, args.payment.organizationId);
    await appendWalletEntry(ctx, {
      wallet,
      kind:
        walletDelta > 0
          ? args.sourceKind === "refund"
            ? "refund_reversal"
            : "dispute_reversal"
          : "dispute_restoration",
      amount: -walletDelta,
      refId: `${args.sourceRef}:wallet:${targetReversedCredits}`,
      paymentId: args.payment._id,
    });
  }

  await reconcilePaymentPublisherClawback(ctx, {
    paymentId: args.payment._id,
    consumerOrganizationId: args.payment.organizationId,
    targetGrossCredits: targetReversedCredits,
    sourceKind: args.sourceKind,
    sourceRef: args.sourceRef,
  });
  await ctx.db.patch(args.payment._id, {
    refundedAmount: args.refundedAmount,
    refundedCredits: args.refundedCredits,
    reversedCredits: targetReversedCredits,
    publisherClawbackTargetCredits: targetReversedCredits,
    status: paymentStatusForProjection({
      grantedCredits: args.payment.grantedCredits,
      refundedCredits: args.refundedCredits,
      disputes: args.disputes,
    }),
    updatedAt: Date.now(),
  });
  return { walletDelta, targetReversedCredits };
}

/** Refund, wallet, and publisher projections commit in one transaction. */
export const applyRefundProjection = internalMutation({
  args: {
    stripeRefundId: v.string(),
    stripeChargeId: v.string(),
    totalRefundedAmount: v.number(),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_charge", (q) =>
        q.eq("stripeChargeId", args.stripeChargeId),
      )
      .unique();
    if (payment === null) return { kind: "ignored" as const };
    if (
      !Number.isSafeInteger(args.totalRefundedAmount) ||
      args.totalRefundedAmount < 0
    ) {
      throw new Error("Invalid Stripe refund amount");
    }
    // Stripe charge snapshots are cumulative. Ignore stale out-of-order views.
    const refundedAmount = Math.max(
      payment.refundedAmount,
      Math.min(args.totalRefundedAmount, payment.amount),
    );
    const refundedCredits = cumulativeRefundCredits({
      grantedCredits: payment.grantedCredits,
      reversedCredits: 0,
      paidAmount: payment.amount,
      totalRefundedAmount: refundedAmount,
    }).targetReversedCredits;
    const disputes = await ctx.db
      .query("paymentDisputes")
      .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
      .collect();
    const projected = await applyEffectivePaymentReversal(ctx, {
      payment,
      refundedAmount,
      refundedCredits,
      disputes,
      sourceKind: "refund",
      sourceRef: `stripe:refund:${args.stripeRefundId}`,
    });
    return { kind: "refund" as const, ...projected };
  },
});

/**
 * Per-dispute state plus money movement. `created`/`updated` never imply funds
 * left the platform; only Stripe funds events move credits.
 */
export const applyDisputeProjection = internalMutation({
  args: {
    stripeEventId: v.string(),
    stripeDisputeId: v.string(),
    stripeChargeId: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: stripeDisputeStatus,
    movement: stripeDisputeMovement,
  },
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
      throw new Error("Invalid Stripe dispute amount");
    }
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_charge", (q) =>
        q.eq("stripeChargeId", args.stripeChargeId),
      )
      .unique();
    if (payment === null) return { kind: "ignored" as const };
    if (payment.currency !== args.currency) {
      throw new Error("Stripe dispute currency does not match payment");
    }
    const existing = await ctx.db
      .query("paymentDisputes")
      .withIndex("by_stripe_dispute", (q) =>
        q.eq("stripeDisputeId", args.stripeDisputeId),
      )
      .unique();
    if (existing !== null && existing.paymentId !== payment._id) {
      throw new Error("Stripe dispute belongs to another payment");
    }
    const status =
      existing !== null &&
      terminalDisputeStatus(existing.status) &&
      !terminalDisputeStatus(args.status)
        ? existing.status
        : args.status;
    const creditsAtRisk = cumulativeRefundCredits({
      grantedCredits: payment.grantedCredits,
      reversedCredits: 0,
      paidAmount: payment.amount,
      totalRefundedAmount: Math.min(args.amount, payment.amount),
    }).targetReversedCredits;
    const now = Date.now();
    const fundsWithdrawn =
      existing?.fundsWithdrawn === true ||
      args.movement === "funds_withdrawn" ||
      args.movement === "funds_reinstated";
    const fundsReinstated =
      existing?.fundsReinstated === true ||
      args.movement === "funds_reinstated";
    if (existing === null) {
      await ctx.db.insert("paymentDisputes", {
        paymentId: payment._id,
        organizationId: payment.organizationId,
        stripeDisputeId: args.stripeDisputeId,
        stripeChargeId: args.stripeChargeId,
        amount: args.amount,
        currency: args.currency,
        status,
        creditsAtRisk,
        fundsWithdrawn,
        fundsReinstated,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        amount: args.amount,
        status,
        creditsAtRisk,
        fundsWithdrawn,
        fundsReinstated,
        updatedAt: now,
      });
    }
    const disputes = await ctx.db
      .query("paymentDisputes")
      .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
      .collect();
    const projected = await applyEffectivePaymentReversal(ctx, {
      payment,
      refundedAmount: payment.refundedAmount,
      refundedCredits: payment.refundedCredits,
      disputes,
      sourceKind: "dispute",
      sourceRef: `stripe:dispute:${args.stripeEventId}`,
    });
    return { kind: "dispute" as const, ...projected };
  },
});

/** Verify all immutable checkout facts before calling this canonical grant path. */
async function fulfillStripeSession(
  ctx: ActionCtx,
  stripe: Stripe,
  sessionId: string,
): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const intent = await ctx.runQuery(
    internal.billing.getCheckoutIntentForSession,
    {
      stripeCheckoutSessionId: sessionId,
    },
  );
  if (intent === null) throw new Error("Unknown Stripe Checkout session");
  const paymentIntentId = stringId(session.payment_intent);
  const customerId = stringId(session.customer);
  if (
    session.payment_status !== "paid" ||
    paymentIntentId === null ||
    customerId !== intent.stripeCustomerId ||
    session.amount_total !== intent.amount ||
    session.currency !== intent.currency
  ) {
    throw new Error(
      "Stripe Checkout session does not match its immutable intent",
    );
  }
  const lines = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 2,
  });
  if (
    lines.data.length !== 1 ||
    stringId(lines.data[0]?.price) !== intent.stripePriceId ||
    lines.data[0]?.quantity !== 1
  ) {
    throw new Error(
      "Stripe Checkout line item does not match its immutable price",
    );
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const paid = await ctx.runMutation(internal.billing.upsertPaidPayment, {
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: stringId(paymentIntent.latest_charge) ?? undefined,
  });
  await ctx.runMutation(internal.wallets.grantPaymentCredits, {
    organizationId: paid.organizationId,
    paymentId: paid.paymentId,
    amount: paid.credits,
    refId: `stripe:payment_intent:${paymentIntentId}`,
  });
  await ctx.runMutation(internal.billing.markPaymentGrantRecorded, {
    paymentId: paid.paymentId,
  });
}

export const getCheckoutIntentForSession = internalQuery({
  args: { stripeCheckoutSessionId: v.string() },
  handler: async (ctx, args) => {
    const intent = await ctx.db
      .query("checkoutIntents")
      .withIndex("by_checkout_session", (q) =>
        q.eq("stripeCheckoutSessionId", args.stripeCheckoutSessionId),
      )
      .unique();
    if (intent === null) return null;
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", intent.organizationId),
      )
      .unique();
    return {
      amount: intent.amount,
      currency: intent.currency,
      stripePriceId: intent.stripePriceId,
      stripeCustomerId: profile?.stripeCustomerId ?? null,
    };
  },
});

async function fulfillPaymentForCharge(
  ctx: ActionCtx,
  stripe: Stripe,
  charge: Stripe.Charge,
): Promise<void> {
  const paymentIntentId = stringId(charge.payment_intent);
  if (paymentIntentId === null) return;
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  const session = sessions.data[0];
  if (session !== undefined) {
    await fulfillStripeSession(ctx, stripe, session.id);
  }
}

export const processStripeEvent = internalAction({
  args: { stripeEventId: v.string() },
  handler: async (ctx, request): Promise<void> => {
    const args = await ctx.runMutation(internal.billing.claimStripeEvent, {
      stripeEventId: request.stripeEventId,
    });
    if (args === null) return;
    try {
      const stripe = stripeClient();
      switch (args.eventType) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          await fulfillStripeSession(ctx, stripe, args.objectId);
          break;
        case "checkout.session.async_payment_failed":
        case "payment_intent.payment_failed":
          break;
        case "charge.refunded": {
          const charge = await stripe.charges.retrieve(args.objectId);
          await fulfillPaymentForCharge(ctx, stripe, charge);
          await ctx.runMutation(internal.billing.applyRefundProjection, {
            stripeRefundId: args.stripeEventId,
            stripeChargeId: charge.id,
            totalRefundedAmount: charge.amount_refunded,
          });
          break;
        }
        case "charge.dispute.created":
        case "charge.dispute.updated":
        case "charge.dispute.closed":
        case "charge.dispute.funds_withdrawn":
        case "charge.dispute.funds_reinstated": {
          const dispute = await stripe.disputes.retrieve(args.objectId);
          const chargeId = stringId(dispute.charge) ?? "";
          if (chargeId !== "") {
            const charge = await stripe.charges.retrieve(chargeId);
            await fulfillPaymentForCharge(ctx, stripe, charge);
          }
          await ctx.runMutation(internal.billing.applyDisputeProjection, {
            stripeEventId: args.stripeEventId,
            stripeDisputeId: dispute.id,
            stripeChargeId: chargeId,
            amount: dispute.amount,
            currency: dispute.currency,
            status: dispute.status,
            movement:
              args.eventType === "charge.dispute.funds_withdrawn"
                ? "funds_withdrawn"
                : args.eventType === "charge.dispute.funds_reinstated"
                  ? "funds_reinstated"
                  : "none",
          });
          break;
        }
        case "v2.core.account.updated":
        case "v2.core.account[configuration.recipient].updated":
        case "v2.core.account[configuration.recipient].capability_status_updated":
        case "v2.core.account[requirements].updated": {
          await ctx.scheduler.runAfter(
            2_000,
            internal.payouts.refreshConnectedAccount,
            { stripeConnectedAccountId: args.objectId },
          );
          break;
        }
        case "transfer.created":
        case "transfer.updated":
        case "transfer.failed":
        case "transfer.reversed": {
          const transfer = await stripe.transfers.retrieve(args.objectId);
          await ctx.runMutation(internal.payouts.projectStripeTransfer, {
            stripeTransferId: transfer.id,
            state:
              args.eventType === "transfer.reversed"
                ? "reversed"
                : args.eventType === "transfer.failed"
                  ? "failed"
                  : "succeeded",
            failureReason: undefined,
          });
          break;
        }
        case "payout.created":
        case "payout.paid":
        case "payout.failed": {
          const payout =
            args.stripeAccount === "platform"
              ? await stripe.payouts.retrieve(args.objectId)
              : await stripe.payouts.retrieve(
                  args.objectId,
                  {},
                  { stripeAccount: args.stripeAccount },
                );
          await ctx.runMutation(internal.payouts.projectConnectedPayout, {
            stripeConnectedAccountId: args.stripeAccount,
            stripePayoutId: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            status:
              payout.status === "paid"
                ? "paid"
                : payout.status === "failed"
                  ? "failed"
                  : payout.status === "canceled"
                    ? "canceled"
                    : "pending",
            failureCode: payout.failure_code ?? undefined,
            arrivalDate:
              payout.arrival_date === null
                ? undefined
                : payout.arrival_date * 1000,
          });
          break;
        }
        default:
          await ctx.runMutation(internal.billing.finishStripeEvent, {
            stripeEventId: args.stripeEventId,
            status: "ignored",
          });
          return;
      }
      await ctx.runMutation(internal.billing.finishStripeEvent, {
        stripeEventId: args.stripeEventId,
        status: "processed",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "Stripe event processing failed";
      await ctx.runMutation(internal.billing.failStripeEvent, {
        stripeEventId: args.stripeEventId,
        error: message,
      });
    }
  },
});

export const getBillingState = query({
  args: { checkoutSessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined)
      throw new Error("Active organization required");
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (organization === null)
      throw new Error("Active organization is not provisioned");
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .unique();
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .order("desc")
      .take(50);
    let checkout: {
      id: Id<"checkoutIntents">;
      status: Doc<"checkoutIntents">["status"];
    } | null = null;
    if (args.checkoutSessionId !== undefined) {
      const intent = await ctx.db
        .query("checkoutIntents")
        .withIndex("by_checkout_session", (q) =>
          q.eq("stripeCheckoutSessionId", args.checkoutSessionId!),
        )
        .unique();
      if (intent !== null && intent.organizationId === organization._id) {
        checkout = { id: intent._id, status: intent.status };
      }
    }
    return {
      wallet: {
        balance: wallet?.balance ?? 0,
        sequence: wallet?.sequence ?? 0,
      },
      packs: [...CREDIT_PACKS],
      checkout,
      payments: payments.map((payment) => ({
        id: payment._id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        credits: payment.grantedCredits,
        createdAt: payment.createdAt,
        failureReason: payment.failureReason,
      })),
    };
  },
});

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function endOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export const cycleBreakdown = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args) => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const cycleStart = startOfUtcMonth(Date.now());
    const cycleEnd = endOfUtcMonth(Date.now());
    const events = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_at", (q) =>
        q
          .eq("organizationId", org._id)
          .gte("at", cycleStart)
          .lt("at", cycleEnd),
      )
      .collect();
    const byKey = new Map<string, { calls: number; credits: number }>();
    const byProject = new Map<
      Id<"projects">,
      { calls: number; credits: number }
    >();
    for (const event of events) {
      const key = byKey.get(event.keyId) ?? { calls: 0, credits: 0 };
      key.calls += 1;
      key.credits += event.credits;
      byKey.set(event.keyId, key);
      const project = byProject.get(event.projectId) ?? {
        calls: 0,
        credits: 0,
      };
      project.calls += 1;
      project.credits += event.credits;
      byProject.set(event.projectId, project);
    }
    const projects = await Promise.all(
      [...byProject.entries()].map(async ([projectId, row]) => {
        const project = await ctx.db.get(projectId);
        return {
          projectId,
          name: project?.name ?? "Unknown project",
          slug: project?.slug ?? "unknown",
          ...row,
        };
      }),
    );
    return {
      cycleStart,
      cycleEnd,
      totalCalls: events.length,
      totalCredits: events.reduce((total, event) => total + event.credits, 0),
      byKey: [...byKey.entries()]
        .map(([keyId, row]) => ({ keyId, ...row }))
        .sort(
          (left, right) =>
            right.credits - left.credits ||
            left.keyId.localeCompare(right.keyId),
        ),
      byProject: projects.sort(
        (left, right) =>
          right.credits - left.credits || left.slug.localeCompare(right.slug),
      ),
    };
  },
});
