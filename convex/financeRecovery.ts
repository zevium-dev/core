import type Stripe from "stripe";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { stripeClient } from "./billing";
import { assertFinanceMigrationAllowsRuntime } from "./lib/financeMigrationGate";

const TEST_PAYOUT_PURPOSE = "zevium_usd_settlement_e2e";
const source = v.union(
  v.object({ kind: v.literal("event"), id: v.string() }),
  v.object({ kind: v.literal("payout"), id: v.string() }),
);
const checkoutProof = v.object({
  kind: v.literal("foreign_checkout"),
  sessionId: v.string(),
  paymentIntentId: v.optional(v.string()),
  chargeId: v.optional(v.string()),
  clerkOrgId: v.string(),
  checkoutIntentId: v.string(),
  livemode: v.literal(false),
  clerkStatus: v.literal(404),
});
const payoutProof = v.object({
  kind: v.literal("unlinked_test_payout"),
  id: v.string(),
  accountId: v.string(),
  amount: v.number(),
  currency: v.string(),
  status: v.string(),
  livemode: v.literal(false),
  purpose: v.literal(TEST_PAYOUT_PURPOSE),
});

export const sourceRecord = internalQuery({
  args: { source },
  handler: async (ctx, { source }) =>
    source.kind === "event"
      ? await ctx.db
          .query("paymentEvents")
          .withIndex("by_stripe_event", (q) => q.eq("stripeEventId", source.id))
          .unique()
      : await ctx.db
          .query("connectedPayouts")
          .withIndex("by_stripe_payout", (q) =>
            q.eq("stripePayoutId", source.id),
          )
          .unique(),
});

async function assertForeignCheckout(
  ctx: QueryCtx | MutationCtx,
  proof: {
    sessionId: string;
    paymentIntentId?: string;
    chargeId?: string;
    clerkOrgId: string;
    checkoutIntentId: string;
  },
) {
  const intentId = ctx.db.normalizeId(
    "checkoutIntents",
    proof.checkoutIntentId,
  );
  const [org, tombstone, intent, sessionIntent, payment] = await Promise.all([
    ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", proof.clerkOrgId))
      .unique(),
    ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", proof.clerkOrgId))
      .unique(),
    intentId === null ? null : ctx.db.get(intentId),
    ctx.db
      .query("checkoutIntents")
      .withIndex("by_checkout_session", (q) =>
        q.eq("stripeCheckoutSessionId", proof.sessionId),
      )
      .unique(),
    ctx.db
      .query("payments")
      .withIndex("by_checkout_session", (q) =>
        q.eq("stripeCheckoutSessionId", proof.sessionId),
      )
      .unique(),
  ]);
  if (org || tombstone || intent || sessionIntent || payment)
    throw new Error("Stripe source belongs to this deployment");
  if (proof.paymentIntentId !== undefined) {
    const [intent, payment] = await Promise.all([
      ctx.db
        .query("checkoutIntents")
        .withIndex("by_payment_intent", (q) =>
          q.eq("stripePaymentIntentId", proof.paymentIntentId!),
        )
        .unique(),
      ctx.db
        .query("payments")
        .withIndex("by_payment_intent", (q) =>
          q.eq("stripePaymentIntentId", proof.paymentIntentId!),
        )
        .unique(),
    ]);
    if (intent || payment)
      throw new Error("Stripe source belongs to this deployment");
  }
  if (
    proof.chargeId !== undefined &&
    (await ctx.db
      .query("payments")
      .withIndex("by_charge", (q) => q.eq("stripeChargeId", proof.chargeId!))
      .unique())
  ) {
    throw new Error("Stripe source belongs to this deployment");
  }
}

async function assertUnlinkedAccount(
  ctx: QueryCtx | MutationCtx,
  accountId: string,
) {
  const [profile, claim, onboarding, transfer] = await Promise.all([
    ctx.db
      .query("organizationPayments")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", accountId),
      )
      .unique(),
    ctx.db
      .query("connectedAccountClaims")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", accountId),
      )
      .unique(),
    ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", accountId),
      )
      .first(),
    ctx.db
      .query("publisherTransfers")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", accountId),
      )
      .first(),
  ]);
  if (profile || claim || onboarding || transfer)
    throw new Error("Stripe account belongs to this deployment");
}

/** Operator-only, provider-backed isolation; original source facts remain stored. */
export const recordQuarantine = internalMutation({
  args: {
    source,
    proof: v.union(checkoutProof, payoutProof),
    providerRequestIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    if (
      args.providerRequestIds.length === 0 ||
      args.providerRequestIds.length > 8 ||
      args.providerRequestIds.some((id) => id.trim() === "")
    )
      throw new Error("Provider request evidence is required");
    const operationId = `foreign-stripe:${args.source.kind}:${args.source.id}`;
    const prior = await ctx.db
      .query("financeReconciliationCases")
      .withIndex("by_operation", (q) => q.eq("operationId", operationId))
      .unique();
    if (prior !== null) return prior._id;
    const now = Date.now();
    if (
      args.source.kind === "event" &&
      args.proof.kind === "foreign_checkout"
    ) {
      const event = await ctx.db
        .query("paymentEvents")
        .withIndex("by_stripe_event", (q) =>
          q.eq("stripeEventId", args.source.id),
        )
        .unique();
      const outbox = await ctx.db
        .query("stripeEventOutbox")
        .withIndex("by_stripe_event", (q) =>
          q.eq("stripeEventId", args.source.id),
        )
        .unique();
      if (
        event === null ||
        event.status !== "failed" ||
        event.stripeAccount !== "platform" ||
        outbox !== null ||
        !(
          (event.eventType === "checkout.session.completed" &&
            event.objectId === args.proof.sessionId) ||
          (event.eventType === "charge.refunded" &&
            event.objectId === args.proof.chargeId)
        )
      ) {
        throw new Error(
          "Only unleased legacy failed Stripe receipts can be isolated",
        );
      }
      await assertForeignCheckout(ctx, args.proof);
      const caseId = await ctx.db.insert("financeReconciliationCases", {
        kind: "foreign_stripe_event",
        status: "quarantined",
        operationId,
        reason:
          "Provider-confirmed test Checkout belongs outside this deployment and its production Clerk instance",
        candidateIds: [event.objectId],
        candidateCount: 1,
        providerRequestIds: args.providerRequestIds,
        attempts: 1,
        resolution: JSON.stringify({
          proofVersion: 1,
          proof: args.proof,
          original: event,
        }),
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(event._id, {
        status: "ignored",
        quarantineCaseId: caseId,
        processedAt: now,
      });
      return caseId;
    }
    if (
      args.source.kind === "payout" &&
      args.proof.kind === "unlinked_test_payout"
    ) {
      const payout = await ctx.db
        .query("connectedPayouts")
        .withIndex("by_stripe_payout", (q) =>
          q.eq("stripePayoutId", args.source.id),
        )
        .unique();
      if (
        payout === null ||
        args.proof.id !== payout.stripePayoutId ||
        args.proof.accountId !== payout.stripeConnectedAccountId ||
        args.proof.amount !== payout.amount ||
        args.proof.currency !== payout.currency ||
        args.proof.status !== payout.status
      ) {
        throw new Error("Test payout differs from provider proof");
      }
      await assertUnlinkedAccount(ctx, args.proof.accountId);
      const caseId = await ctx.db.insert("financeReconciliationCases", {
        kind: "foreign_test_payout",
        status: "quarantined",
        operationId,
        reason:
          "Unlinked, provider-confirmed USD settlement test account payout",
        candidateIds: [payout.stripePayoutId],
        candidateCount: 1,
        providerRequestIds: args.providerRequestIds,
        attempts: 1,
        resolution: JSON.stringify({
          proofVersion: 1,
          proof: args.proof,
          original: payout,
        }),
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(payout._id, { quarantineCaseId: caseId });
      return caseId;
    }
    throw new Error("Stripe quarantine source does not match proof");
  },
});

export async function assertQuarantinedStripeEvent(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"paymentEvents">,
) {
  const row =
    event.quarantineCaseId === undefined
      ? null
      : await ctx.db.get(event.quarantineCaseId);
  if (
    row === null ||
    row.kind !== "foreign_stripe_event" ||
    row.status !== "quarantined" ||
    row.resolution === undefined ||
    row.providerRequestIds.length === 0 ||
    row.operationId !== `foreign-stripe:event:${event.stripeEventId}` ||
    event.status !== "ignored" ||
    event.stripeAccount !== "platform"
  )
    throw new Error("Stripe receipt quarantine lacks provider evidence");
  const resolution = JSON.parse(row.resolution) as {
    proofVersion?: unknown;
    proof?: Record<string, unknown>;
  };
  const proof = resolution.proof;
  if (
    resolution.proofVersion !== 1 ||
    proof?.kind !== "foreign_checkout" ||
    proof.livemode !== false ||
    proof.clerkStatus !== 404 ||
    typeof proof.sessionId !== "string" ||
    typeof proof.clerkOrgId !== "string" ||
    typeof proof.checkoutIntentId !== "string" ||
    (proof.paymentIntentId !== undefined &&
      typeof proof.paymentIntentId !== "string") ||
    (proof.chargeId !== undefined && typeof proof.chargeId !== "string") ||
    !(
      (event.eventType === "checkout.session.completed" &&
        event.objectId === proof.sessionId) ||
      (event.eventType === "charge.refunded" &&
        event.objectId === proof.chargeId)
    )
  )
    throw new Error("Stripe receipt quarantine differs from provider evidence");
  await assertForeignCheckout(ctx, {
    sessionId: proof.sessionId,
    clerkOrgId: proof.clerkOrgId,
    checkoutIntentId: proof.checkoutIntentId,
    paymentIntentId: proof.paymentIntentId as string | undefined,
    chargeId: proof.chargeId as string | undefined,
  });
}

export async function assertQuarantinedTestPayout(
  ctx: QueryCtx | MutationCtx,
  payout: Doc<"connectedPayouts">,
) {
  const row =
    payout.quarantineCaseId === undefined
      ? null
      : await ctx.db.get(payout.quarantineCaseId);
  if (
    row === null ||
    row.kind !== "foreign_test_payout" ||
    row.status !== "quarantined" ||
    row.resolution === undefined ||
    row.providerRequestIds.length === 0 ||
    row.operationId !== `foreign-stripe:payout:${payout.stripePayoutId}`
  )
    throw new Error("Payout quarantine lacks provider evidence");
  const resolution = JSON.parse(row.resolution) as {
    proofVersion?: unknown;
    proof?: Record<string, unknown>;
  };
  const proof = resolution.proof;
  if (
    resolution.proofVersion !== 1 ||
    proof?.kind !== "unlinked_test_payout" ||
    proof.livemode !== false ||
    proof.purpose !== TEST_PAYOUT_PURPOSE ||
    proof.id !== payout.stripePayoutId ||
    proof.accountId !== payout.stripeConnectedAccountId ||
    proof.amount !== payout.amount ||
    proof.currency !== payout.currency ||
    proof.status !== payout.status
  ) {
    throw new Error("Payout quarantine differs from provider evidence");
  }
  await assertUnlinkedAccount(ctx, payout.stripeConnectedAccountId);
}

export const quarantineForeignTestSource = internalAction({
  args: { source },
  handler: async (ctx, { source }): Promise<{ quarantined: true }> => {
    const row = await ctx.runQuery(internal.financeRecovery.sourceRecord, {
      source,
    });
    if (row === null) throw new Error("Stripe source record is missing");
    if (row.quarantineCaseId !== undefined) return { quarantined: true };
    const stripe = stripeClient();
    const providerRequestIds: string[] = [];
    if (source.kind === "payout" && "stripePayoutId" in row) {
      const [account, payout] = await Promise.all([
        stripe.accounts.retrieve(row.stripeConnectedAccountId),
        stripe.payouts.retrieve(
          row.stripePayoutId,
          {},
          { stripeAccount: row.stripeConnectedAccountId },
        ),
      ]);
      if (payout.livemode || account.metadata?.purpose !== TEST_PAYOUT_PURPOSE)
        throw new Error(
          "Only identified settlement test payouts can be isolated",
        );
      await ctx.runMutation(internal.financeRecovery.recordQuarantine, {
        source,
        proof: {
          kind: "unlinked_test_payout",
          id: payout.id,
          accountId: account.id,
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
          livemode: false,
          purpose: TEST_PAYOUT_PURPOSE,
        },
        providerRequestIds: [
          account.lastResponse.requestId,
          payout.lastResponse.requestId,
        ],
      });
      return { quarantined: true };
    }
    if (
      source.kind !== "event" ||
      !("eventType" in row) ||
      row.stripeAccount !== "platform"
    )
      throw new Error("Unsupported foreign Stripe source");
    let chargeId: string | undefined;
    let session: Stripe.Checkout.Session;
    if (row.eventType === "checkout.session.completed") {
      const observed = await stripe.checkout.sessions.retrieve(row.objectId);
      session = observed;
      providerRequestIds.push(observed.lastResponse.requestId);
    } else if (row.eventType === "charge.refunded") {
      const charge = await stripe.charges.retrieve(row.objectId);
      const intentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (charge.livemode || intentId === undefined)
        throw new Error(
          "Only foreign test charges with Checkout provenance can be isolated",
        );
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: intentId,
        limit: 2,
      });
      if (sessions.data.length !== 1 || sessions.has_more)
        throw new Error("Foreign charge Checkout provenance is ambiguous");
      providerRequestIds.push(
        charge.lastResponse.requestId,
        sessions.lastResponse.requestId,
      );
      session = sessions.data[0];
      chargeId = charge.id;
    } else throw new Error("Unsupported foreign Stripe event");
    const clerkOrgId = session.metadata?.clerkOrgId;
    const checkoutIntentId = session.metadata?.checkoutIntentId;
    if (session.livemode || !clerkOrgId || !checkoutIntentId)
      throw new Error("Foreign Stripe scope metadata is missing");
    const key = process.env.CLERK_SECRET_KEY;
    if (!key?.startsWith("sk_live_"))
      throw new Error(
        "Production Clerk instance key is required for foreign-source reconciliation",
      );
    const response = await fetch(
      `https://api.clerk.com/v1/organizations/${encodeURIComponent(clerkOrgId)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (response.status !== 404)
      throw new Error(
        "Foreign Stripe organization is not confirmed absent from the production Clerk instance",
      );
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    await ctx.runMutation(internal.financeRecovery.recordQuarantine, {
      source,
      proof: {
        kind: "foreign_checkout",
        sessionId: session.id,
        paymentIntentId,
        chargeId,
        clerkOrgId,
        checkoutIntentId,
        livemode: false,
        clerkStatus: 404,
      },
      providerRequestIds,
    });
    return { quarantined: true };
  },
});
