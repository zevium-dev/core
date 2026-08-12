import Stripe from "stripe";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getOrgByClerkId,
  requireActiveOrg,
  requireAdmin,
  requireIdentity,
  requireOrgAdmin,
  requireOrgMemberBySlug,
} from "./lib/auth";
import {
  enqueuePaymentPublisherReconciliation,
  processPaymentPublisherReconciliationChunk,
} from "./lib/publisherLedger";
import { appendWalletEntry, getOrCreateWallet } from "./wallets";
import {
  commitPaymentReversal,
  preflightPaymentReversal,
  recordPositiveFundingSource,
  requireVerifiedWalletFunding,
} from "./lib/funding";
import { assertFinanceMigrationAllowsRuntime } from "./lib/financeMigrationGate";
import {
  paymentStatusForProjection,
  terminalDisputeStatus,
} from "./lib/paymentStatus";

/** Pinned alongside `stripe@22.3.1`; upgrade only as an explicit migration. */
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;
const BILLING_CYCLE_SCAN_CAP = 10_000;

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
    await assertFinanceMigrationAllowsRuntime(ctx);
    const organization = await getOrgByClerkId(ctx, args.clerkOrgId);
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
    await assertFinanceMigrationAllowsRuntime(ctx);
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
    await assertFinanceMigrationAllowsRuntime(ctx);
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

export const markCheckoutIntentTerminal = internalMutation({
  args: {
    stripeCheckoutSessionId: v.string(),
    status: v.union(v.literal("failed"), v.literal("expired")),
  },
  handler: async (ctx, args): Promise<void> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const intent = await ctx.db
      .query("checkoutIntents")
      .withIndex("by_checkout_session", (q) =>
        q.eq("stripeCheckoutSessionId", args.stripeCheckoutSessionId),
      )
      .unique();
    if (intent === null) return;
    if (
      intent.status === "complete" ||
      intent.status === "failed" ||
      intent.status === "expired"
    ) {
      return;
    }
    await ctx.db.patch(intent._id, {
      status: args.status,
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
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    const clerkOrgId = claims.orgId;
    if (clerkOrgId === undefined) {
      throw new Error("Active organization required");
    }
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
      cancelUrl: `${origin}/app/billing?checkout_cancel=${prepared.checkoutIntentId}`,
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

export function stripeEventRequiresProviderReconciliation(
  eventType: string,
): boolean {
  return (
    eventType.startsWith("checkout.session.") ||
    eventType.startsWith("payment_intent.") ||
    eventType === "charge.refunded" ||
    eventType.startsWith("refund.") ||
    eventType.startsWith("charge.dispute.") ||
    eventType.startsWith("transfer.") ||
    eventType.startsWith("payout.")
  );
}

async function getStripeOutbox(
  ctx: MutationCtx,
  stripeEventId: string,
): Promise<Doc<"stripeEventOutbox"> | null> {
  return await ctx.db
    .query("stripeEventOutbox")
    .withIndex("by_stripe_event", (q) => q.eq("stripeEventId", stripeEventId))
    .unique();
}

async function ensureStripeOutbox(
  ctx: MutationCtx,
  event: Doc<"paymentEvents">,
): Promise<Doc<"stripeEventOutbox">> {
  const existing = await getStripeOutbox(ctx, event.stripeEventId);
  if (existing !== null) {
    if (
      existing.paymentEventId !== event._id ||
      existing.eventType !== event.eventType ||
      existing.objectId !== event.objectId
    ) {
      throw new Error("Stripe outbox immutable receipt facts changed");
    }
    return existing;
  }
  const terminalState =
    event.status === "processed"
      ? ("applied" as const)
      : event.status === "ignored"
        ? ("ignored" as const)
        : event.status === "provider_reconciliation_required"
          ? ("provider_reconciliation_required" as const)
          : event.status === "dead_letter"
            ? ("dead_letter" as const)
            : event.status === "failed" &&
                event.attempts >= STRIPE_EVENT_MAX_ATTEMPTS
              ? stripeEventRequiresProviderReconciliation(event.eventType)
                ? ("provider_reconciliation_required" as const)
                : ("dead_letter" as const)
              : event.status === "failed"
                ? ("retry_wait" as const)
                : ("queued" as const);
  const now = Date.now();
  const id = await ctx.db.insert("stripeEventOutbox", {
    paymentEventId: event._id,
    stripeEventId: event.stripeEventId,
    eventType: event.eventType,
    objectId: event.objectId,
    state: terminalState,
    attemptCycle:
      event.status === "received"
        ? 0
        : Math.min(event.attempts, STRIPE_EVENT_MAX_ATTEMPTS),
    totalAttempts: event.attempts,
    lastError: event.lastError,
    reconciliationReason:
      terminalState === "provider_reconciliation_required" ||
      terminalState === "dead_letter"
        ? event.lastError
        : undefined,
    nextAttemptAt:
      terminalState === "retry_wait" ? (event.nextAttemptAt ?? now) : undefined,
    appliedAt: event.processedAt,
    createdAt: event.receivedAt,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (created === null) throw new Error("Stripe outbox creation failed");
  if (
    event.status === "failed" &&
    (terminalState === "provider_reconciliation_required" ||
      terminalState === "dead_letter")
  ) {
    await ctx.db.patch(event._id, {
      status: terminalState,
      nextAttemptAt: undefined,
      leaseExpiresAt: undefined,
    });
  }
  return created;
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
    // Migration must either see an accepted receipt or reject its transaction
    // so Stripe retries it later. Never admit a post-fence row that cannot be
    // included in the stable global watermark.
    await assertFinanceMigrationAllowsRuntime(ctx);
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
      await ctx.db.patch(existing._id, {
        deliveries: existing.deliveries + 1,
      });
      await ensureStripeOutbox(ctx, existing);
      // HTTP redelivery is evidence, not operator intent. It must never reset
      // attempts, skip backoff, or revive poison receipts. Cron owns recovery.
      return { isNew: false, scheduled: false };
    }
    const now = Date.now();
    const paymentEventId = await ctx.db.insert("paymentEvents", {
      stripeEventId: args.stripeEventId,
      stripeAccount: args.stripeAccount,
      eventType: args.eventType,
      objectId: args.objectId,
      status: "received",
      attempts: 0,
      deliveries: 1,
      receivedAt: now,
    });
    await ctx.db.insert("stripeEventOutbox", {
      paymentEventId,
      stripeEventId: args.stripeEventId,
      eventType: args.eventType,
      objectId: args.objectId,
      state: "queued",
      attemptCycle: 0,
      totalAttempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    // Scheduler write commits atomically with receipt. Returning 200 now means
    // event is durably queued, not merely stored and forgotten.
    await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
      stripeEventId: args.stripeEventId,
    });
    return { isNew: true, scheduled: true };
  },
});

/** Explicit operator resume. Cumulative attempts remain immutable evidence. */
export const replayStripeEvent = mutation({
  args: { stripeEventId: v.string() },
  handler: async (ctx, args): Promise<{ scheduled: true }> => {
    const claims = await requireAdmin(ctx);
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (event === null) throw new Error("Stripe event not found");
    if (
      event.status !== "failed" &&
      event.status !== "provider_reconciliation_required" &&
      event.status !== "dead_letter"
    ) {
      throw new Error("Only blocked Stripe events can be resumed");
    }
    const now = Date.now();
    const outbox = await ensureStripeOutbox(ctx, event);
    if (
      outbox.state !== "retry_wait" &&
      outbox.state !== "provider_reconciliation_required" &&
      outbox.state !== "dead_letter"
    ) {
      throw new Error("Stripe event outbox is not resumable");
    }
    await ctx.db.patch(outbox._id, {
      state: "queued",
      attemptCycle: 0,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
      lastError: undefined,
      reconciliationReason: undefined,
      resumedAt: now,
      resumedBy: claims.subject,
      updatedAt: now,
    });
    await ctx.db.patch(event._id, {
      status: "received",
      nextAttemptAt: undefined,
      leaseExpiresAt: undefined,
      lastError: undefined,
      lastReplayedAt: now,
      lastReplayedBy: claims.subject,
      replayCount: (event.replayCount ?? 0) + 1,
    });
    await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
      stripeEventId: args.stripeEventId,
    });
    return { scheduled: true };
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
    const outbox = await ensureStripeOutbox(ctx, event);
    if (
      outbox.state === "applied" ||
      outbox.state === "ignored" ||
      outbox.state === "provider_reconciliation_required" ||
      outbox.state === "dead_letter"
    ) {
      return null;
    }
    if (outbox.state === "leased" && (outbox.leaseExpiresAt ?? 0) > now) {
      return null;
    }
    if (outbox.state === "retry_wait" && (outbox.nextAttemptAt ?? 0) > now) {
      return null;
    }
    if (outbox.attemptCycle >= STRIPE_EVENT_MAX_ATTEMPTS) {
      const money = stripeEventRequiresProviderReconciliation(event.eventType);
      const status = money
        ? ("provider_reconciliation_required" as const)
        : ("dead_letter" as const);
      const reason =
        outbox.lastError ?? "Stripe event exhausted its processing lease";
      await ctx.db.patch(outbox._id, {
        state: status,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        reconciliationReason: reason,
        updatedAt: now,
      });
      await ctx.db.patch(event._id, {
        status,
        lastError: reason,
        nextAttemptAt: undefined,
        leaseExpiresAt: undefined,
      });
      return null;
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(event._id, {
      status: "processing",
      attempts: outbox.totalAttempts + 1,
      nextAttemptAt: undefined,
      leaseExpiresAt: now + STRIPE_EVENT_LEASE_MS,
      lastError: undefined,
    });
    await ctx.db.patch(outbox._id, {
      state: "leased",
      attemptCycle: outbox.attemptCycle + 1,
      totalAttempts: outbox.totalAttempts + 1,
      leaseToken,
      leaseExpiresAt: now + STRIPE_EVENT_LEASE_MS,
      nextAttemptAt: undefined,
      lastError: undefined,
      updatedAt: now,
    });
    return {
      stripeEventId: event.stripeEventId,
      stripeAccount: event.stripeAccount,
      eventType: event.eventType,
      objectId: event.objectId,
      leaseToken,
    };
  },
});

export const finishStripeEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    leaseToken: v.string(),
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
    const outbox = await getStripeOutbox(ctx, event.stripeEventId);
    if (
      outbox === null ||
      outbox.state !== "leased" ||
      outbox.leaseToken !== args.leaseToken
    ) {
      return;
    }
    await ctx.db.patch(event._id, {
      status: args.status,
      lastError: undefined,
      nextAttemptAt: undefined,
      leaseExpiresAt: undefined,
      processedAt: Date.now(),
    });
    await ctx.db.patch(outbox._id, {
      state: args.status === "processed" ? "applied" : "ignored",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
      lastError: undefined,
      appliedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const failStripeEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.db
      .query("paymentEvents")
      .withIndex("by_stripe_event", (q) =>
        q.eq("stripeEventId", args.stripeEventId),
      )
      .unique();
    if (event === null) {
      return;
    }
    const outbox = await getStripeOutbox(ctx, event.stripeEventId);
    if (
      outbox === null ||
      outbox.state !== "leased" ||
      outbox.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const retry = outbox.attemptCycle < STRIPE_EVENT_MAX_ATTEMPTS;
    const delay = stripeRetryDelay(outbox.attemptCycle);
    const now = Date.now();
    const nextAttemptAt = retry ? now + delay : undefined;
    const terminal = stripeEventRequiresProviderReconciliation(event.eventType)
      ? ("provider_reconciliation_required" as const)
      : ("dead_letter" as const);
    await ctx.db.patch(event._id, {
      status: retry ? "failed" : terminal,
      lastError: args.error.slice(0, 240),
      nextAttemptAt,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch(outbox._id, {
      state: retry ? "retry_wait" : terminal,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt,
      lastError: args.error.slice(0, 240),
      reconciliationReason: retry ? undefined : args.error.slice(0, 240),
      updatedAt: now,
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
    const queued = await ctx.db
      .query("stripeEventOutbox")
      .withIndex("by_state_next_attempt", (q) => q.eq("state", "queued"))
      .take(100);
    const retrying = await ctx.db
      .query("stripeEventOutbox")
      .withIndex("by_state_next_attempt", (q) => q.eq("state", "retry_wait"))
      .filter((q) => q.lte(q.field("nextAttemptAt"), now))
      .take(100);
    const expired = await ctx.db
      .query("stripeEventOutbox")
      .withIndex("by_state_lease", (q) => q.eq("state", "leased"))
      .filter((q) => q.lte(q.field("leaseExpiresAt"), now))
      .take(100);
    let scheduled = 0;
    const ids = new Set<string>();
    for (const outbox of [...queued, ...retrying, ...expired]) {
      if (ids.has(outbox.stripeEventId)) continue;
      ids.add(outbox.stripeEventId);
      await ctx.scheduler.runAfter(0, internal.billing.processStripeEvent, {
        stripeEventId: outbox.stripeEventId,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});

/** Public operator visibility for every accepted but unresolved receipt. */
export const listStripeReconciliationQueue = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const reconciliation = await ctx.db
      .query("stripeEventOutbox")
      .withIndex("by_state_next_attempt", (q) =>
        q.eq("state", "provider_reconciliation_required"),
      )
      .take(100);
    const deadLetters = await ctx.db
      .query("stripeEventOutbox")
      .withIndex("by_state_next_attempt", (q) => q.eq("state", "dead_letter"))
      .take(100);
    return [...reconciliation, ...deadLetters].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    );
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
    await assertFinanceMigrationAllowsRuntime(ctx);
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
      if (
        existing.organizationId !== intent.organizationId ||
        existing.checkoutIntentId !== intent._id ||
        existing.stripeCheckoutSessionId !== args.stripeCheckoutSessionId ||
        existing.amount !== intent.amount ||
        existing.currency !== intent.currency ||
        existing.grantedCredits !== intent.credits ||
        (existing.stripeChargeId !== undefined &&
          args.stripeChargeId !== undefined &&
          existing.stripeChargeId !== args.stripeChargeId)
      ) {
        throw new Error("Payment replay changed immutable provider facts");
      }
      requireVerifiedPaymentFinance(existing);
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
      walletReversedCredits: 0,
      publisherClawbackTargetCredits: 0,
      reversalSequence: 0,
      financeMigrationStatus: "verified",
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
    await assertFinanceMigrationAllowsRuntime(ctx);
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

const stripeRefundStatus = v.union(
  v.literal("pending"),
  v.literal("requires_action"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

type StripeRefundStatus = Doc<"paymentExposures">["sourceStatus"] & string;

function requireVerifiedPaymentFinance(payment: Doc<"payments">): {
  walletReversedCredits: number;
  publisherClawbackTargetCredits: number;
  reversalSequence: number;
} {
  if (
    payment.financeMigrationStatus !== "verified" ||
    payment.financeMigrationJobId !== undefined ||
    payment.walletReversedCredits === undefined ||
    payment.publisherClawbackTargetCredits === undefined ||
    payment.reversalSequence === undefined
  ) {
    throw new Error("Payment finance migration is not verified");
  }
  if (
    payment.walletReversedCredits < 0 ||
    payment.publisherClawbackTargetCredits < 0 ||
    payment.reversalSequence < 0
  ) {
    throw new Error("Payment finance projection is invalid");
  }
  return {
    walletReversedCredits: payment.walletReversedCredits,
    publisherClawbackTargetCredits: payment.publisherClawbackTargetCredits,
    reversalSequence: payment.reversalSequence,
  };
}

function refundStatusActive(status: StripeRefundStatus): boolean {
  return status !== "failed" && status !== "canceled";
}

function safeIntegerSum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} overflow`);
  return value;
}

function normalizedStripeRefundStatus(
  status: Stripe.Refund["status"],
): StripeRefundStatus {
  if (
    status === "pending" ||
    status === "requires_action" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return status;
  }
  throw new Error("Stripe refund returned an unsupported status");
}

const stripeDisputeMovement = v.union(
  v.literal("none"),
  v.literal("funds_withdrawn"),
  v.literal("funds_reinstated"),
);

async function boundedPaymentDisputes(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
): Promise<Doc<"paymentDisputes">[]> {
  const disputes = await ctx.db
    .query("paymentDisputes")
    .withIndex("by_payment", (q) => q.eq("paymentId", paymentId))
    .take(101);
  if (disputes.length > 100) {
    throw new Error("Payment exceeds 100 bounded dispute sources");
  }
  return disputes;
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
    sourceAmount: number;
    sourceRequestedCredits: number;
    sourceActive: boolean;
    sourceStatus?: StripeRefundStatus;
  },
): Promise<{ walletDelta: number; targetReversedCredits: number }> {
  const verified = requireVerifiedPaymentFinance(args.payment);
  if (
    !Number.isSafeInteger(args.sourceRequestedCredits) ||
    args.sourceRequestedCredits < 0 ||
    !Number.isSafeInteger(args.sourceAmount) ||
    args.sourceAmount < 0
  ) {
    throw new Error("Invalid payment exposure source amount");
  }
  const existingSource = await ctx.db
    .query("paymentExposures")
    .withIndex("by_source", (q) => q.eq("sourceRef", args.sourceRef))
    .unique();
  if (
    existingSource !== null &&
    existingSource.paymentId !== args.payment._id
  ) {
    throw new Error("Payment exposure source belongs to another payment");
  }
  const now = Date.now();
  if (args.sourceKind === "refund" && args.sourceStatus === undefined) {
    throw new Error("Stripe refund status is required");
  }
  if (existingSource === null) {
    await ctx.db.insert("paymentExposures", {
      paymentId: args.payment._id,
      organizationId: args.payment.organizationId,
      sourceKind: args.sourceKind,
      sourceRef: args.sourceRef,
      sourceAmount: args.sourceAmount,
      sourceAmountExact: true,
      sourceStatus: args.sourceStatus,
      migrationBackfilled: false,
      requestedCredits: args.sourceRequestedCredits,
      effectiveCredits: 0,
      walletCredits: 0,
      publisherCredits: 0,
      appliedPublisherCredits: 0,
      active: args.sourceActive,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    if (
      existingSource.sourceKind !== args.sourceKind ||
      ((existingSource.sourceAmountExact ?? true) &&
        existingSource.sourceAmount !== args.sourceAmount)
    ) {
      throw new Error("Payment exposure immutable source facts changed");
    }
    const priorStatus = existingSource.sourceStatus;
    if (
      priorStatus !== undefined &&
      priorStatus !== args.sourceStatus &&
      (priorStatus === "succeeded" ||
        priorStatus === "failed" ||
        priorStatus === "canceled")
    ) {
      throw new Error("Stripe refund terminal status changed");
    }
    await ctx.db.patch(existingSource._id, {
      sourceAmount: args.sourceAmount,
      sourceAmountExact: true,
      migrationBackfilled: false,
      sourceStatus: args.sourceStatus,
      requestedCredits: args.sourceRequestedCredits,
      active: args.sourceActive,
      updatedAt: now,
    });
  }

  const exposures = await ctx.db
    .query("paymentExposures")
    .withIndex("by_payment_created", (q) => q.eq("paymentId", args.payment._id))
    .order("asc")
    .take(101);
  if (exposures.length > 100) {
    throw new Error("Payment exceeds 100 bounded exposure sources");
  }
  const ordered = [...exposures].sort((left, right) => {
    if (left.sourceKind !== right.sourceKind) {
      return left.sourceKind === "refund" ? -1 : 1;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.sourceRef.localeCompare(right.sourceRef);
  });
  const activeRefundedAmount = Math.min(
    args.payment.amount,
    ordered
      .filter(
        (exposure) =>
          exposure.sourceKind === "refund" &&
          exposure.active &&
          exposure.sourceStatus !== undefined &&
          refundStatusActive(exposure.sourceStatus),
      )
      .reduce((sum, exposure) => sum + exposure.sourceAmount, 0),
  );
  if (!Number.isSafeInteger(activeRefundedAmount)) {
    throw new Error("Stripe refund aggregate overflow");
  }
  const activeRefundedCredits = cumulativeRefundCredits({
    grantedCredits: args.payment.grantedCredits,
    reversedCredits: 0,
    paidAmount: args.payment.amount,
    totalRefundedAmount: activeRefundedAmount,
  }).targetReversedCredits;
  let capRemaining = args.payment.grantedCredits;
  let refundAmountRunning = 0;
  let refundCreditsRunning = 0;
  const effectiveById = new Map<Id<"paymentExposures">, number>();
  for (const exposure of ordered) {
    let requestedEffective = 0;
    if (exposure.active && exposure.sourceKind === "refund") {
      refundAmountRunning = Math.min(
        args.payment.amount,
        safeIntegerSum(
          refundAmountRunning,
          exposure.sourceAmount,
          "Stripe refund aggregate",
        ),
      );
      const cumulativeCredits = cumulativeRefundCredits({
        grantedCredits: args.payment.grantedCredits,
        reversedCredits: 0,
        paidAmount: args.payment.amount,
        totalRefundedAmount: refundAmountRunning,
      }).targetReversedCredits;
      requestedEffective = cumulativeCredits - refundCreditsRunning;
      refundCreditsRunning = cumulativeCredits;
    } else if (exposure.active) {
      requestedEffective = exposure.requestedCredits;
    }
    const effective = Math.min(requestedEffective, capRemaining);
    effectiveById.set(exposure._id, effective);
    capRemaining -= effective;
  }
  if (refundCreditsRunning !== activeRefundedCredits) {
    throw new Error("Stripe refund sources do not conserve cumulative credits");
  }
  const targetReversedCredits = args.payment.grantedCredits - capRemaining;
  const currentWalletReversedCredits = verified.walletReversedCredits;
  const currentPublisherClawbackCredits =
    verified.publisherClawbackTargetCredits;
  const effectiveDelta = targetReversedCredits - args.payment.reversedCredits;
  const wallet = await getOrCreateWallet(ctx, args.payment.organizationId);
  let targetWalletReversedCredits = currentWalletReversedCredits;
  let walletDelta = 0;

  if (effectiveDelta > 0) {
    const reversalPlan = await preflightPaymentReversal(ctx, {
      wallet,
      paymentId: args.payment._id,
      requestedCredits: effectiveDelta,
    });
    walletDelta = reversalPlan.walletCredits;
    targetWalletReversedCredits += walletDelta;
    if (walletDelta > 0) {
      const reversal = await appendWalletEntry(ctx, {
        wallet,
        kind:
          args.sourceKind === "refund" ? "refund_reversal" : "dispute_reversal",
        amount: -walletDelta,
        refId: `${args.sourceRef}:wallet:reverse:${verified.reversalSequence + 1}:${targetWalletReversedCredits}`,
        paymentId: args.payment._id,
      });
      const provenance = await commitPaymentReversal(ctx, {
        plan: reversalPlan,
        walletSequence: reversal.wallet.sequence,
        now,
      });
      await ctx.db.insert("walletFundingReversals", {
        walletId: wallet._id,
        organizationId: args.payment.organizationId,
        walletEntryId: reversal.entryId,
        paymentId: args.payment._id,
        grossCredits: walletDelta,
        provenance,
        createdAt: now,
      });
    }
  } else if (effectiveDelta < 0) {
    // Restore publisher exposure first. Only remaining reduction recreates
    // wallet inventory, preserving unspent-first reversal policy.
    const creditsToRestore = Math.min(
      Math.max(0, -effectiveDelta - currentPublisherClawbackCredits),
      currentWalletReversedCredits,
    );
    walletDelta = -creditsToRestore;
    targetWalletReversedCredits -= creditsToRestore;
    if (creditsToRestore > 0) {
      const restored = await appendWalletEntry(ctx, {
        wallet,
        kind:
          args.sourceKind === "refund"
            ? "refund_restoration"
            : "dispute_restoration",
        amount: creditsToRestore,
        refId: `${args.sourceRef}:wallet:restore:${verified.reversalSequence + 1}:${targetWalletReversedCredits}`,
        paymentId: args.payment._id,
      });
      const entry = await ctx.db.get(restored.entryId);
      if (entry === null)
        throw new Error("Restoration ledger entry is missing");
      await recordPositiveFundingSource(ctx, {
        wallet: restored.wallet,
        sourceKind: "restoration",
        sourceRef: entry.refId,
        amount: creditsToRestore,
        refundable: true,
        paymentId: args.payment._id,
        createdAt: entry.createdAt,
      });
    }
  }

  const targetPublisherClawbackCredits =
    targetReversedCredits - targetWalletReversedCredits;
  if (targetPublisherClawbackCredits < 0) {
    throw new Error("Payment publisher exposure cannot be negative");
  }
  let walletCoverageRemaining = targetWalletReversedCredits;
  let publisherTargetSum = 0;
  let publisherTargetsChanged = false;
  for (const exposure of ordered) {
    const effectiveCredits = effectiveById.get(exposure._id) ?? 0;
    const walletCredits = Math.min(effectiveCredits, walletCoverageRemaining);
    const publisherCredits = effectiveCredits - walletCredits;
    walletCoverageRemaining -= walletCredits;
    publisherTargetSum += publisherCredits;
    if (exposure.publisherCredits !== publisherCredits) {
      publisherTargetsChanged = true;
    }
    await ctx.db.patch(exposure._id, {
      effectiveCredits,
      walletCredits,
      publisherCredits,
      allocationCursor:
        exposure.publisherCredits === publisherCredits
          ? exposure.allocationCursor
          : undefined,
      updatedAt: now,
    });
  }
  if (
    walletCoverageRemaining !== 0 ||
    publisherTargetSum !== targetPublisherClawbackCredits
  ) {
    throw new Error("Payment reversal source allocation does not balance");
  }
  if (publisherTargetsChanged) {
    await enqueuePaymentPublisherReconciliation(ctx, {
      paymentId: args.payment._id,
      consumerOrganizationId: args.payment.organizationId,
    });
  }
  await ctx.db.patch(args.payment._id, {
    refundedAmount: activeRefundedAmount,
    refundedCredits: activeRefundedCredits,
    reversedCredits: targetReversedCredits,
    walletReversedCredits: targetWalletReversedCredits,
    publisherClawbackTargetCredits: targetPublisherClawbackCredits,
    reversalSequence:
      effectiveDelta === 0
        ? verified.reversalSequence
        : verified.reversalSequence + 1,
    status: paymentStatusForProjection({
      grantedCredits: args.payment.grantedCredits,
      refundedCredits: activeRefundedCredits,
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
    refundAmount: v.optional(v.number()),
    totalRefundedAmount: v.number(),
    status: stripeRefundStatus,
  },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_charge", (q) =>
        q.eq("stripeChargeId", args.stripeChargeId),
      )
      .unique();
    if (payment === null) return { kind: "ignored" as const };
    requireVerifiedPaymentFinance(payment);
    if (
      !Number.isSafeInteger(args.totalRefundedAmount) ||
      args.totalRefundedAmount < 0 ||
      args.totalRefundedAmount > payment.amount
    ) {
      throw new Error("Invalid Stripe refund amount");
    }
    const sourceRef = `stripe:refund:${args.stripeRefundId}`;
    const existingExposure = await ctx.db
      .query("paymentExposures")
      .withIndex("by_source", (q) => q.eq("sourceRef", sourceRef))
      .unique();
    const sourceAmount =
      existingExposure !== null &&
      !(existingExposure.sourceAmountExact ?? true) &&
      args.refundAmount !== undefined
        ? args.refundAmount
        : (existingExposure?.sourceAmount ??
          args.refundAmount ??
          Math.max(0, args.totalRefundedAmount - payment.refundedAmount));
    if (!Number.isSafeInteger(sourceAmount) || sourceAmount <= 0) {
      if (existingExposure !== null) {
        return {
          kind: "refund" as const,
          walletDelta: 0,
          targetReversedCredits: payment.reversedCredits,
        };
      }
      throw new Error("Stripe refund source amount must be positive");
    }
    const sourceRequestedCredits = cumulativeRefundCredits({
      grantedCredits: payment.grantedCredits,
      reversedCredits: 0,
      paidAmount: payment.amount,
      totalRefundedAmount: Math.min(sourceAmount, payment.amount),
    }).targetReversedCredits;
    const disputes = await boundedPaymentDisputes(ctx, payment._id);
    const projected = await applyEffectivePaymentReversal(ctx, {
      payment,
      refundedAmount: payment.refundedAmount,
      refundedCredits: payment.refundedCredits,
      disputes,
      sourceKind: "refund",
      sourceRef,
      sourceAmount,
      sourceRequestedCredits,
      sourceActive: refundStatusActive(args.status),
      sourceStatus: args.status,
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
    await assertFinanceMigrationAllowsRuntime(ctx);
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
    requireVerifiedPaymentFinance(payment);
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
    if (
      existing !== null &&
      (existing.stripeChargeId !== args.stripeChargeId ||
        existing.amount !== args.amount ||
        existing.currency !== args.currency)
    ) {
      throw new Error("Stripe dispute immutable facts changed");
    }
    const status =
      existing !== null && terminalDisputeStatus(existing.status)
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
    const disputes = await boundedPaymentDisputes(ctx, payment._id);
    const projected = await applyEffectivePaymentReversal(ctx, {
      payment,
      refundedAmount: payment.refundedAmount,
      refundedCredits: payment.refundedCredits,
      disputes,
      sourceKind: "dispute",
      sourceRef: `stripe:dispute:${args.stripeDisputeId}`,
      sourceAmount: args.amount,
      sourceRequestedCredits: creditsAtRisk,
      sourceActive: fundsWithdrawn && !fundsReinstated,
    });
    return { kind: "dispute" as const, ...projected };
  },
});

export const processPublisherReconciliation = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) =>
    await processPaymentPublisherReconciliationChunk(ctx, args.paymentId),
});

/** Crash recovery schedules a bounded number of unfinished journals. */
export const recoverPublisherReconciliations = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const pending = await ctx.db
      .query("publisherReconciliationJobs")
      .withIndex("by_status_updated", (q) => q.eq("status", "pending"))
      .take(25);
    const running = await ctx.db
      .query("publisherReconciliationJobs")
      .withIndex("by_status_updated", (q) => q.eq("status", "running"))
      .take(25);
    for (const job of [...pending, ...running]) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.processPublisherReconciliation,
        { paymentId: job.paymentId },
      );
    }
    return { scheduled: pending.length + running.length };
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
          await ctx.runMutation(internal.billing.markCheckoutIntentTerminal, {
            stripeCheckoutSessionId: args.objectId,
            status: "failed",
          });
          break;
        case "checkout.session.expired":
          await ctx.runMutation(internal.billing.markCheckoutIntentTerminal, {
            stripeCheckoutSessionId: args.objectId,
            status: "expired",
          });
          break;
        case "payment_intent.payment_failed":
          break;
        case "charge.refunded": {
          const charge = await stripe.charges.retrieve(args.objectId);
          await fulfillPaymentForCharge(ctx, stripe, charge);
          const refunds = await stripe.refunds.list({
            charge: charge.id,
            limit: 100,
          });
          if (refunds.has_more) {
            throw new Error("Charge exceeds bounded 100-refund projection cap");
          }
          for (const refund of refunds.data) {
            await ctx.runMutation(internal.billing.applyRefundProjection, {
              stripeRefundId: refund.id,
              stripeChargeId: charge.id,
              refundAmount: refund.amount,
              totalRefundedAmount: charge.amount_refunded,
              status: normalizedStripeRefundStatus(refund.status),
            });
          }
          break;
        }
        case "refund.created":
        case "refund.updated":
        case "refund.failed": {
          const refund = await stripe.refunds.retrieve(args.objectId);
          const chargeId = stringId(refund.charge);
          if (chargeId === null) break;
          const charge = await stripe.charges.retrieve(chargeId);
          await fulfillPaymentForCharge(ctx, stripe, charge);
          await ctx.runMutation(internal.billing.applyRefundProjection, {
            stripeRefundId: refund.id,
            stripeChargeId: charge.id,
            refundAmount: refund.amount,
            totalRefundedAmount: charge.amount_refunded,
            status: normalizedStripeRefundStatus(refund.status),
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
            publisherTransferId: transfer.metadata.publisherTransferId,
            amount: transfer.amount,
            amountReversed: transfer.amount_reversed,
            currency: transfer.currency,
            destination: stringId(transfer.destination) ?? "",
            platformAccountId: transfer.metadata.platformAccountId,
            correlationNonce: transfer.metadata.correlationNonce,
            correlationHmac: transfer.metadata.correlationHmac,
            metadataRepairVersion:
              transfer.metadata.metadataRepairVersion === undefined
                ? undefined
                : Number(transfer.metadata.metadataRepairVersion),
            requestFingerprint: transfer.metadata.requestFingerprint,
            failed: args.eventType === "transfer.failed",
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
            leaseToken: args.leaseToken,
            status: "ignored",
          });
          return;
      }
      await ctx.runMutation(internal.billing.finishStripeEvent, {
        stripeEventId: args.stripeEventId,
        leaseToken: args.leaseToken,
        status: "processed",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "Stripe event processing failed";
      await ctx.runMutation(internal.billing.failStripeEvent, {
        stripeEventId: args.stripeEventId,
        leaseToken: args.leaseToken,
        error: message,
      });
    }
  },
});

export const getBillingState = query({
  args: {
    checkoutSessionId: v.optional(v.string()),
    checkoutIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const { access, org: organization } = await requireActiveOrg(ctx);
    const canManageBilling = access.capabilities.manageBilling;
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .unique();
    const payments = canManageBilling
      ? await ctx.db
          .query("payments")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", organization._id),
          )
          .order("desc")
          .take(50)
      : [];
    let checkout: {
      id: Id<"checkoutIntents">;
      status: Doc<"checkoutIntents">["status"] | "canceled";
    } | null = null;
    if (canManageBilling) {
      if (wallet !== null) {
        await requireVerifiedWalletFunding(ctx, wallet);
      }
      for (const payment of payments) requireVerifiedPaymentFinance(payment);
    }
    if (canManageBilling && args.checkoutSessionId !== undefined) {
      const intent = await ctx.db
        .query("checkoutIntents")
        .withIndex("by_checkout_session", (q) =>
          q.eq("stripeCheckoutSessionId", args.checkoutSessionId as string),
        )
        .unique();
      if (intent !== null && intent.organizationId === organization._id) {
        checkout = { id: intent._id, status: intent.status };
      }
    } else if (args.checkoutIntentId !== undefined) {
      const intentId = ctx.db.normalizeId(
        "checkoutIntents",
        args.checkoutIntentId,
      );
      const intent = intentId === null ? null : await ctx.db.get(intentId);
      if (intent !== null && intent.organizationId === organization._id) {
        checkout = {
          id: intent._id,
          status: intent.status === "complete" ? "complete" : "canceled",
        };
      }
    }
    return {
      access,
      wallet: {
        balance: wallet?.balance ?? 0,
      },
      packs: canManageBilling ? [...CREDIT_PACKS] : [],
      checkout,
      payments: payments.map((payment) => ({
        id: payment._id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        credits: payment.grantedCredits,
        refundedCredits: payment.refundedCredits,
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

/** Linear month-end projection from elapsed cycle usage. */
export function projectedCycleCredits(
  totalCredits: number,
  cycleStart: number,
  cycleEnd: number,
  asOf: number,
): number {
  if (totalCredits <= 0) return 0;
  const duration = cycleEnd - cycleStart;
  const elapsed = Math.min(Math.max(asOf - cycleStart, 1), duration);
  if (duration <= 0) return totalCredits;
  return Math.max(
    totalCredits,
    Math.round((totalCredits * duration) / elapsed),
  );
}

export const cycleBreakdown = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const { access, claims, org } = await requireOrgMemberBySlug(
      ctx,
      args.orgSlug,
    );
    const canViewOrgUsage = access.capabilities.viewOrgUsage;
    const asOf = Date.now();
    const cycleStart = startOfUtcMonth(asOf);
    const cycleEnd = endOfUtcMonth(asOf);
    const scanned = canViewOrgUsage
      ? await ctx.db
          .query("usageEvents")
          .withIndex("by_org_at", (q) =>
            q
              .eq("organizationId", org._id)
              .gte("at", cycleStart)
              .lt("at", cycleEnd),
          )
          .take(BILLING_CYCLE_SCAN_CAP + 1)
      : await ctx.db
          .query("usageEvents")
          .withIndex("by_org_owner_at", (q) =>
            q
              .eq("organizationId", org._id)
              .eq("ownerUserId", claims.subject)
              .gte("at", cycleStart)
              .lt("at", cycleEnd),
          )
          .take(BILLING_CYCLE_SCAN_CAP + 1);
    const scanTruncated = scanned.length > BILLING_CYCLE_SCAN_CAP;
    const visibleEvents = scanned.slice(0, BILLING_CYCLE_SCAN_CAP);
    const byKey = new Map<string, { calls: number; credits: number }>();
    const byMember = new Map<string, { calls: number; credits: number }>();
    const byProject = new Map<
      Id<"projects">,
      { name: string; slug: string; calls: number; credits: number }
    >();

    const byEndpoint = new Map<
      string,
      {
        projectId: Id<"projects">;
        method: string;
        endpoint: string;
        calls: number;
        credits: number;
      }
    >();
    const keySettings = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .collect();
    const keyMetadata = new Map(keySettings.map((row) => [row.keyId, row]));
    for (const event of visibleEvents) {
      const key = byKey.get(event.keyId) ?? { calls: 0, credits: 0 };
      key.calls += 1;
      key.credits += event.credits;
      byKey.set(event.keyId, key);
      if (event.projectName === undefined || event.projectSlug === undefined) {
        throw new Error("Billing cycle migration is not verified");
      }
      const project = byProject.get(event.projectId) ?? {
        name: event.projectName,
        slug: event.projectSlug,
        calls: 0,
        credits: 0,
      };
      project.name = event.projectName;
      project.slug = event.projectSlug;
      project.calls += 1;
      project.credits += event.credits;
      byProject.set(event.projectId, project);

      const ownerUserId =
        event.ownerUserId ?? keyMetadata.get(event.keyId)?.ownerUserId;
      if (canViewOrgUsage) {
        const memberKey = ownerUserId ?? "unattributed";
        const member = byMember.get(memberKey) ?? { calls: 0, credits: 0 };
        member.calls += 1;
        member.credits += event.credits;
        byMember.set(memberKey, member);
      }

      const endpointKey = `${event.projectId}\u0000${event.method}\u0000${event.endpoint}`;
      const endpoint = byEndpoint.get(endpointKey) ?? {
        projectId: event.projectId,
        method: event.method,
        endpoint: event.endpoint,
        calls: 0,
        credits: 0,
      };
      endpoint.calls += 1;
      endpoint.credits += event.credits;
      byEndpoint.set(endpointKey, endpoint);
    }

    const projectDocs = new Map<Id<"projects">, Doc<"projects"> | null>();
    await Promise.all(
      [...byProject.keys()].map(async (projectId) => {
        projectDocs.set(projectId, await ctx.db.get(projectId));
      }),
    );
    const projectRefs = new Map<Id<"projects">, string | null>();
    await Promise.all(
      [...byProject.keys()].map(async (projectId) => {
        const project = projectDocs.get(projectId);
        if (project === null || project === undefined) {
          projectRefs.set(projectId, null);
          return;
        }
        const publisher = await ctx.db.get(project.organizationId);
        projectRefs.set(
          projectId,
          publisher?.publicHandle
            ? `${publisher.publicHandle}/${project.slug}`
            : null,
        );
      }),
    );
    const projects = [...byProject.entries()].map(([projectId, row]) => ({
      projectRef: projectRefs.get(projectId) ?? null,
      ...row,
    }));
    const members = await Promise.all(
      [...byMember.entries()].map(async ([userId, row]) => {
        const user =
          userId === "unattributed"
            ? null
            : await ctx.db
                .query("users")
                .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", userId))
                .unique();
        return {
          memberId: userId === "unattributed" ? null : userId,
          name: user?.name ?? "Unattributed member",
          ...row,
        };
      }),
    );
    const totalCredits = visibleEvents.reduce(
      (total, event) => total + event.credits,
      0,
    );
    const dimensionLimit = 100;
    const sortedKeys = [...byKey.entries()]
      .map(([keyId, row]) => {
        const metadata = keyMetadata.get(keyId);
        return {
          keyId: canViewOrgUsage
            ? keyId
            : keyId.length > 4
              ? `••••${keyId.slice(-4)}`
              : "••••",
          keyName: metadata?.keyName ?? "Unnamed key",
          memberId: canViewOrgUsage ? (metadata?.ownerUserId ?? null) : null,
          ...row,
        };
      })
      .sort(
        (left, right) =>
          right.credits - left.credits || left.keyId.localeCompare(right.keyId),
      );
    const sortedProjects = projects.sort(
      (left, right) =>
        right.credits - left.credits || left.slug.localeCompare(right.slug),
    );
    const sortedEndpoints = [...byEndpoint.values()]
      .map((row) => {
        const project = projectDocs.get(row.projectId);
        return {
          projectRef: projectRefs.get(row.projectId) ?? null,
          projectName: project?.name ?? "Deleted API",
          projectSlug: project?.slug ?? "deleted",
          method: row.method,
          endpoint: row.endpoint,
          calls: row.calls,
          credits: row.credits,
        };
      })
      .sort(
        (left, right) =>
          right.credits - left.credits ||
          left.endpoint.localeCompare(right.endpoint),
      );
    const sortedMembers = members.sort(
      (left, right) =>
        right.credits - left.credits || left.name.localeCompare(right.name),
    );
    return {
      access,
      scope: canViewOrgUsage ? ("organization" as const) : ("member" as const),
      cycleStart,
      cycleEnd,

      asOf,
      totalCalls: visibleEvents.length,
      totalCredits,
      ownCalls: canViewOrgUsage ? null : visibleEvents.length,
      ownCredits: canViewOrgUsage ? null : totalCredits,
      projectedCredits: projectedCycleCredits(
        totalCredits,
        cycleStart,
        cycleEnd,
        asOf,
      ),
      byKey: sortedKeys.slice(0, dimensionLimit),
      byProject: sortedProjects.slice(0, dimensionLimit),
      byEndpoint: sortedEndpoints.slice(0, dimensionLimit),
      byMember: sortedMembers.slice(0, dimensionLimit),
      breakdownTruncated: {
        members: sortedMembers.length > dimensionLimit,
        keys: sortedKeys.length > dimensionLimit,
        projects: sortedProjects.length > dimensionLimit,
        endpoints: sortedEndpoints.length > dimensionLimit,
      },
      scanTruncated,
      scanCap: BILLING_CYCLE_SCAN_CAP,
    };
  },
});
