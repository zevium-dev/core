import {
  financePage,
  FINANCE_PAGE_INTERVAL_MS,
  FINANCE_TRANSIENT_RETRY_MS,
  FINANCE_THROTTLE_RETRY_MS,
  isTransientFinanceError,
} from "./money/throughput";
import { atomsToCredits } from "./accounting";
import { onboarding, verifiedAccount } from "./connect";
import { v, ConvexError } from "convex/values";
import { z } from "zod";
import {
  internalAction,
  internalMutation,
  internalQuery,
  action,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type Stripe from "stripe";
import { internal } from "./_generated/api";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import {
  stripeConfig,
  verifiedStripe,
  providerId,
  definitiveStripeFailure,
} from "./lib/stripe";
import {
  prepareTransfer,
  claimTransfer,
  projectTransfer,
  transferFailure,
  transferScan,
  type TransferFact,
} from "./money/transfers";
import { releaseEarning } from "./money/publisherLedger";
import { openCase } from "./money/reconciliationCases";
export const preparePublisherTransfer = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    return prepareTransfer(ctx, org);
  },
});
export const claimDispatch = internalMutation({
  args: { id: v.id("publisherTransfers") },
  handler: (ctx, args) => claimTransfer(ctx, args.id),
});
const factSchema = z.object({
  id: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  destination: z.string(),
  livemode: z.boolean(),
  platformAccountId: z.string(),
  nonce: z.string(),
  fingerprint: z.string(),
  reversedCents: z.number().int().nonnegative(),
});
export const project = internalMutation({
  args: {
    id: v.id("publisherTransfers"),
    json: v.string(),
    token: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    projectTransfer(
      ctx,
      args.id,
      factSchema.parse(JSON.parse(args.json)),
      args.token,
    ),
});
export const failDispatch = internalMutation({
  args: {
    id: v.id("publisherTransfers"),
    token: v.string(),
    definitive: v.boolean(),
  },
  handler: (ctx, args) =>
    transferFailure(ctx, args.id, args.token, args.definitive),
});
export const scan = internalMutation({
  args: {
    id: v.id("publisherTransfers"),
    token: v.string(),
    cursor: v.optional(v.string()),
    candidates: v.array(v.string()),
    done: v.boolean(),
  },
  handler: (ctx, a) =>
    transferScan(ctx, a.id, a.token, a.cursor, a.candidates, a.done),
});
export function transferFact(t: Stripe.Transfer): TransferFact {
  return {
    id: t.id,
    amount: t.amount,
    currency: t.currency,
    destination: providerId(t.destination) ?? "",
    livemode: t.livemode,
    platformAccountId: stripeConfig().account,
    nonce: t.metadata.operationNonce ?? "",
    fingerprint: t.metadata.requestFingerprint ?? "",
    reversedCents: t.amount_reversed,
  };
}
export const dispatch = internalAction({
  args: { id: v.id("publisherTransfers") },
  handler: async (ctx, { id }) => {
    const t = await ctx.runMutation(internal.payouts.claimDispatch, { id });
    if (!t) return;
    let dispatched = false,
      created = false;
    try {
      const stripe = await verifiedStripe();
      if (t.platformAccountId !== stripeConfig().account || t.livemode)
        throw new Error("Wrong transfer environment");
      const account = await stripe.v2.core.accounts.retrieve(t.destination, {
        include: [
          "configuration.recipient",
          "defaults",
          "identity",
          "requirements",
        ],
      });
      const identity = verifiedAccount(account);
      const owner = await ctx.runQuery(internal.connect.byAccount, {
        accountId: t.destination,
      });
      if (
        !owner ||
        owner._id !== t.publisherOrganizationId ||
        identity.organizationId !== owner._id ||
        identity.operationId !== owner.connectOperation?.id ||
        identity.fingerprint !== owner.connectOperation?.requestFingerprint ||
        identity.country !== owner.connectOperation?.country ||
        account.id !== t.destination ||
        account.livemode ||
        account.closed ||
        account.configuration?.recipient?.capabilities?.stripe_balance
          ?.stripe_transfers?.status !== "active"
      ) {
        // Before any attempt this is definitively side-effect free; on retries it cannot erase uncertainty.
        await ctx.runMutation(internal.payouts.failDispatch, {
          id,
          token: t.leaseToken!,
          definitive: t.attempts === 1,
        });
        return;
      }
      if (t.stripeTransferId) {
        const provider = await stripe.transfers.retrieve(t.stripeTransferId);
        await ctx.runMutation(internal.payouts.project, {
          id,
          token: t.leaseToken!,
          json: JSON.stringify(transferFact(provider)),
        });
        return;
      }
      if (Date.now() >= t.safeRetryUntil!) {
        const page = await stripe.transfers.list({
          destination: t.destination,
          limit: 100,
          ...(t.providerCursor ? { starting_after: t.providerCursor } : {}),
          created: { gte: Math.floor(t.firstAttemptAt! / 1000) - 60 },
        });
        const matches = page.data.filter(
          (x) => x.metadata.operationNonce === t.operationNonce,
        );
        // After the replay window, retain every candidate across the complete scan.
        // Operator adoption (or a verified webhook) resolves the allocation; no prefix proves uniqueness.
        await ctx.runMutation(internal.payouts.scan, {
          id,
          token: t.leaseToken!,
          cursor: page.has_more ? page.data.at(-1)?.id : undefined,
          candidates: matches.map((x) => x.id),
          done: !page.has_more,
        });
        return;
      }
      dispatched = true;
      const response = await stripe.transfers.create(
        {
          amount: t.amountCents,
          currency: "usd",
          destination: t.destination,
          metadata: {
            operationNonce: t.operationNonce,
            requestFingerprint: t.requestFingerprint,
            transferId: t._id,
          },
        },
        { idempotencyKey: t.idempotencyKey },
      );
      created = true;
      const provider = await stripe.transfers.retrieve(response.id);
      await ctx.runMutation(internal.payouts.project, {
        id,
        token: t.leaseToken!,
        json: JSON.stringify(transferFact(provider)),
      });
    } catch (error) {
      await ctx.runMutation(internal.payouts.failDispatch, {
        id,
        token: t.leaseToken!,
        definitive:
          t.attempts === 1 &&
          dispatched &&
          !created &&
          definitiveStripeFailure(error),
      });
    }
  },
});
export const initiatePublisherTransfer = action({
  args: {},
  handler: async (ctx): Promise<{ transferId: Id<"publisherTransfers"> }> => {
    const transferId = await ctx.runMutation(
      internal.payouts.preparePublisherTransfer,
      {},
    );
    await ctx.scheduler.runAfter(0, internal.payouts.dispatch, {
      id: transferId,
    });
    return { transferId };
  },
});
export const releaseOne = internalMutation({
  args: { id: v.id("publisherEarnings") },
  handler: (ctx, a) =>
    financePage(ctx, (bounded) => releaseEarning(bounded, a.id)),
});
export const releaseSafely = internalAction({
  args: { id: v.id("publisherEarnings") },
  handler: async (ctx, a) => {
    try {
      const result = await ctx.runMutation(internal.payouts.releaseOne, a);
      if (result === "throttled")
        await ctx.scheduler.runAfter(
          FINANCE_THROTTLE_RETRY_MS,
          internal.payouts.releaseSafely,
          a,
        );
    } catch (error) {
      if (isTransientFinanceError(error)) {
        await ctx.scheduler.runAfter(
          FINANCE_TRANSIENT_RETRY_MS,
          internal.payouts.releaseSafely,
          a,
        );
        return;
      }
      await ctx.runMutation(internal.payouts.releaseFailure, a);
    }
  },
});
export const releaseFailure = internalMutation({
  args: { id: v.id("publisherEarnings") },
  handler: async (ctx, a) => {
    const e = await ctx.db.get(a.id);
    if (!e || e.state !== "pending") return;
    await openCase(ctx, {
      kind: "release",
      operationId: `release:${e._id}`,
      organizationId: e.publisherOrganizationId,
      reason: "Earning release requires review",
    });
    await ctx.db.patch(e._id, { releaseAfter: Date.now() + 86400000 });
  },
});
export const releaseDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_release", (q) =>
        q.eq("state", "pending").lte("releaseAfter", Date.now()),
      )
      .take(25);
    let delay = 0;
    for (const e of rows) {
      await ctx.db.patch(e._id, { releaseAfter: Date.now() + 60000 });
      await ctx.scheduler.runAfter(delay, internal.payouts.releaseSafely, {
        id: e._id,
      });
      delay += FINANCE_PAGE_INTERVAL_MS;
    }
    if (rows.length === 25)
      await ctx.scheduler.runAfter(delay, internal.payouts.releaseDue, {});
  },
});
export const recoverTransfers = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of [
      "prepared",
      "dispatching",
      "retry",
      "reconciling",
    ] as const) {
      const rows = await ctx.db
        .query("publisherTransfers")
        .withIndex("by_due", (q) =>
          q.eq("dispatchState", state).lte("nextAttemptAt", Date.now()),
        )
        .take(25);
      for (const t of rows) {
        await ctx.db.patch(t._id, { nextAttemptAt: Date.now() + 60000 });
        await ctx.scheduler.runAfter(0, internal.payouts.dispatch, {
          id: t._id,
        });
      }
    }
  },
});
export const transferByProvider = internalQuery({
  args: { providerId: v.string() },
  handler: (ctx, a) =>
    ctx.db
      .query("publisherTransfers")
      .withIndex("by_stripe", (q) => q.eq("stripeTransferId", a.providerId))
      .unique(),
});
export const transferById = internalQuery({
  args: { id: v.string() },
  handler: (ctx, a) => {
    const id = ctx.db.normalizeId("publisherTransfers", a.id);
    return id ? ctx.db.get(id) : null;
  },
});
export const getPayoutState = query({
  args: {},
  handler: async (ctx) => {
    const { org } = await requireActiveOrg(ctx);
    const balance = await ctx.db
      .query("publisherBalances")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", org._id),
      )
      .unique();
    const totals = await ctx.db
      .query("usageRollups")
      .withIndex("by_lifetime", (q) =>
        q
          .eq("kind", "lifetime")
          .eq("scope", "publisher")
          .eq("scopeId", org._id)
          .eq("dimension", "total")
          .eq("dimensionKey", "all"),
      )
      .take(128);
    const pendingRiskAtoms = totals.reduce(
      (n, r) => n + (r.kind === "lifetime" ? r.pendingRiskAtoms : 0),
      0,
    );
    const rows = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher_day", (q) =>
        q.eq("publisherOrganizationId", org._id),
      )
      .order("desc")
      .take(50);
    const transfers = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher_time", (q) =>
        q.eq("publisherOrganizationId", org._id),
      )
      .order("desc")
      .take(50);
    const payouts = org.connect
      ? await ctx.db
          .query("connectedPayouts")
          .withIndex("by_account_time", (q) =>
            q.eq("accountId", org.connect!.accountId),
          )
          .order("desc")
          .take(50)
      : [];
    return {
      profile: {
        status: !org.connect
          ? "not_started"
          : org.connect.status === "active"
            ? "enabled"
            : org.connect.status === "pending"
              ? "incomplete"
              : "restricted",
        requirements: org.connect?.requirements ?? [],
      },
      earnings: {
        pendingRisk: atomsToCredits(pendingRiskAtoms),
        available: atomsToCredits(balance?.availableAtoms ?? 0),
        allocated: atomsToCredits(balance?.allocatedAtoms ?? 0),
        transferred: atomsToCredits(balance?.paidAtoms ?? 0),
        reversed: atomsToCredits(balance?.reversedAtoms ?? 0),
        failed: atomsToCredits(balance?.failedAtoms ?? 0),
        totals: {
          pendingRiskAtoms,
          availableAtoms: balance?.availableAtoms ?? 0,
          allocatedAtoms: balance?.allocatedAtoms ?? 0,
          paidAtoms: balance?.paidAtoms ?? 0,
          reversedAtoms: balance?.reversedAtoms ?? 0,
        },
        minimumPayoutCredits: 100000,
        canTransfer:
          org.connect?.status === "active" &&
          (balance?.availableAtoms ?? 0) >= 1000000000,
        rows: rows.map((e) => ({
          id: e._id,
          day: e.day,
          grossCredits: e.grossCredits,
          platformFeeCredits: atomsToCredits(e.platformFeeAtoms),
          netCredits: atomsToCredits(e.netAtoms),
          clawedBackCredits: atomsToCredits(e.clawedBackAtoms),
          availableAt: e.availableAt,
          status:
            e.clawedBackAtoms === e.netAtoms && e.netAtoms > 0
              ? "reversed"
              : e.state,
          createdAt: e.createdAt,
          netAtoms: e.netAtoms,
          clawedBackAtoms: e.clawedBackAtoms,
          releasedAtoms: e.releasedAtoms,
          state: e.state,
        })),
      },
      transfers: transfers.map((t) => ({
        id: t._id,
        status: t.status,
        amount: t.amountCents,
        currency: t.currency,
        amountCents: t.amountCents,
        reversedCents: t.reversedCents,
        createdAt: t.createdAt,
      })),
      payouts: payouts.map((p) => ({
        id: p._id,
        status: p.status,
        amountCents: p.amountCents,
        currency: p.currency,
        arrivalDate: p.arrivalDate,
      })),
    };
  },
});

export const startOnboarding = action({
  args: { country: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ url: string }> => {
    try {
      return await onboarding(ctx, a.country);
    } catch {
      throw new ConvexError(
        "Publisher setup is unavailable or pending reconciliation. Please try again later.",
      );
    }
  },
});
export const refreshOnboarding = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    try {
      return await onboarding(ctx);
    } catch {
      throw new ConvexError(
        "Publisher setup is unavailable or pending reconciliation. Please try again later.",
      );
    }
  },
});
