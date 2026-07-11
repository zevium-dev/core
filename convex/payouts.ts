import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireOrgMemberBySlug } from "./lib/auth";

/**
 * Platform cut 5% -> publishers keep 95%.
 * Local mirror of earnings.ts constant (control-plane bundle stays workspace-free).
 * Must stay in sync with earnings.ts PLATFORM_CUT.
 */
const PLATFORM_CUT = 0.05;
const PUBLISHER_SHARE = 1 - PLATFORM_CUT;

/**
 * Minimum redeemable payout. 100,000 credits = $10
 * (10,000 credits = $1 publisher conversion).
 */
export const MIN_PAYOUT_CREDITS = 100_000;

/**
 * Sum all-time net publisher credits for an org: gather the org's projects,
 * sum consumer usageEvents credits, apply the 95% publisher share.
 * Mirrors earnings.forOrg all-time math (single source would be nicer, but
 * convex queries don't call each other without a runQuery round-trip).
 */
async function orgAllTimeNetCredits(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<number> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .collect();

  let gross = 0;
  for (const project of projects) {
    const events = await ctx.db
      .query("usageEvents")
      .withIndex("by_project_at", (q) => q.eq("projectId", project._id))
      .collect();
    for (const event of events) {
      gross += event.credits;
    }
  }
  return Math.round(gross * PUBLISHER_SHARE);
}

/**
 * Sum credits already spoken for: pending + paid payout requests.
 * Rejected requests are excluded (they release the credits).
 */
async function orgRequestedCredits(
  ctx: QueryCtx,
  clerkOrgId: string,
): Promise<number> {
  const requests = await ctx.db
    .query("payoutRequests")
    .withIndex("by_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .collect();
  let requested = 0;
  for (const r of requests) {
    if (r.status === "pending" || r.status === "paid") {
      requested += r.credits;
    }
  }
  return requested;
}

export type RedeemableCredits = {
  /** All-time net publisher credits earned (95% of gross). */
  netAllTime: number;
  /** Credits already locked in pending or paid payout requests. */
  requested: number;
  /** netAllTime - requested, floored at 0. */
  redeemable: number;
  /** Minimum payout threshold in credits (100,000 = $10). */
  minPayout: number;
};

/**
 * Publisher redeemable balance: all-time net earnings minus credits already
 * locked in pending/paid payout requests.
 */
export const redeemableCredits = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<RedeemableCredits> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const netAllTime = await orgAllTimeNetCredits(ctx, org._id);
    const requested = await orgRequestedCredits(ctx, org.clerkOrgId);
    return {
      netAllTime,
      requested,
      redeemable: Math.max(0, netAllTime - requested),
      minPayout: MIN_PAYOUT_CREDITS,
    };
  },
});

/**
 * Request a payout. Org member only. Validates 0 < credits <= redeemable and
 * credits >= MIN_PAYOUT_CREDITS ($10). Inserts a pending request.
 *
 * No notification on request in this cut — notifications.kind union has no
 * payout kind and schema.ts is out of scope. Follow-up: extend the union with
 * payout_requested/payout_resolved kinds and notify here + on admin resolve.
 */
export const requestPayout = mutation({
  args: {
    orgSlug: v.string(),
    credits: v.number(),
    destination: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"payoutRequests">> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    if (!Number.isInteger(args.credits)) {
      throw new Error("Credits must be a whole number.");
    }
    if (args.credits <= 0) {
      throw new Error("Credits must be greater than zero.");
    }
    if (args.credits < MIN_PAYOUT_CREDITS) {
      throw new Error(
        `Minimum payout is ${MIN_PAYOUT_CREDITS.toLocaleString()} credits ($10).`,
      );
    }
    const destination = args.destination.trim();
    if (destination.length === 0) {
      throw new Error("Payout destination is required.");
    }

    const netAllTime = await orgAllTimeNetCredits(ctx, org._id);
    const requested = await orgRequestedCredits(ctx, org.clerkOrgId);
    const redeemable = Math.max(0, netAllTime - requested);
    if (args.credits > redeemable) {
      throw new Error("Requested credits exceed your redeemable balance.");
    }

    return await ctx.db.insert("payoutRequests", {
      clerkOrgId: org.clerkOrgId,
      credits: args.credits,
      destination,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export type MyPayoutRequest = {
  _id: Id<"payoutRequests">;
  credits: number;
  destination: string;
  status: "pending" | "paid" | "rejected";
  note?: string;
  createdAt: number;
  resolvedAt?: number;
};

/** Paginated payout request history result for an org. */
export type MyPayoutRequestsPage = {
  page: MyPayoutRequest[];
  isDone: boolean;
  continueCursor: string;
};

/**
 * Paginated payout request history for the active org (newest first).
 */
export const listMyRequests = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<MyPayoutRequestsPage> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const result = await ctx.db
      .query("payoutRequests")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .order("desc")
      .paginate(args.paginationOpts);

    const page: MyPayoutRequest[] = result.page.map((r) => ({
      _id: r._id,
      credits: r.credits,
      destination: r.destination,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    }));

    return { ...result, page };
  },
});
