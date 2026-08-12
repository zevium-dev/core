import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { action, mutation, query, type ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isAdmin, requireAdmin } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import {
  repairAndRetrieveStripeTransferMetadata,
  assertConnectedAccountIdentity,
  stripeLivemodeFromSecretKey,
  transferToStripe,
  verifyStripePlatformIdentity,
} from "./payouts";
import { stripeClient } from "./billing";
import { internal } from "./_generated/api";

/** Cap for month-to-date usage count (by_at index range scan). */
const USAGE_STATS_CAP = 50_000;

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Safe admin check (no throw). Returns false for unauthenticated,
 * env-unset, or non-admin users. Safe for any authed caller.
 */
export const isAdminQuery = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    return await isAdmin(ctx);
  },
});

/** Bounded, idempotent rollout step; run repeatedly until remaining is zero. */
export const migrateSecurityRollout = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    credentials: { migrated: number; remaining: number };
    handles: { updated: number; collisions: number };
    remainingPlaintext: number;
    remainingUnencrypted: number;
    remainingMissingHandles: number;
  }> => {
    await requireAdmin(ctx);
    const credentials: { migrated: number; remaining: number } =
      await ctx.runMutation(
        internal.upstreamCredentials.migrateLegacyPlaintext,
        {},
      );
    const handles: { updated: number; collisions: number } =
      await ctx.runMutation(internal.organizations.backfillPublicHandles, {});
    const rows = await ctx.db.query("upstreamCredentials").collect();
    const organizations = await ctx.db.query("organizations").collect();
    return {
      credentials,
      handles,
      remainingPlaintext: rows.filter((row) => Boolean(row.secret)).length,
      remainingUnencrypted: rows.filter(
        (row) => !row.ciphertext || !row.iv || !row.keyVersion,
      ).length,
      remainingMissingHandles: organizations.filter(
        (organization) => organization.publicHandle === undefined,
      ).length,
    };
  },
});

export type PlatformStats = {
  orgs: number;
  projects: {
    draft: number;
    published: number;
  };
  projectsTotal: number;
  usageThisMonth: number;
  usageCapped: boolean;
  usageCap: number;
};

/**
 * Platform-wide counts. All bounded/indexed.
 * usageThisMonth scans by_at index from month start, capped at USAGE_STATS_CAP.
 */
export const platformStats = query({
  args: {},
  handler: async (ctx): Promise<PlatformStats> => {
    await requireAdmin(ctx);

    const allOrgs = await ctx.db.query("organizations").collect();
    const allProjects = await ctx.db.query("projects").collect();
    const draft = allProjects.filter((p) => p.status === "draft").length;
    const published = allProjects.filter(
      (p) => p.status === "published",
    ).length;

    const monthStart = startOfUtcMonth(Date.now());
    const monthEvents = await ctx.db
      .query("usageEvents")
      .withIndex("by_at", (q) => q.gte("at", monthStart))
      .take(USAGE_STATS_CAP);

    return {
      orgs: allOrgs.length,
      projects: { draft, published },
      projectsTotal: allProjects.length,
      usageThisMonth: monthEvents.length,
      usageCapped: monthEvents.length >= USAGE_STATS_CAP,
      usageCap: USAGE_STATS_CAP,
    };
  },
});

export type AdminOrgView = {
  _id: Id<"organizations">;
  clerkOrgId: string;
  name: string;
  slug: string;
  balance: number;
};

export const listOrgs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const result = await ctx.db
      .query("organizations")
      .order("desc")
      .paginate(args.paginationOpts);

    const page: AdminOrgView[] = [];
    for (const org of result.page) {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
        .unique();
      page.push({
        _id: org._id,
        clerkOrgId: org.clerkOrgId,
        name: org.name,
        slug: org.slug,
        balance: wallet?.balance ?? 0,
      });
    }

    return { ...result, page };
  },
});

export type AdminProjectView = {
  _id: Id<"projects">;
  name: string;
  slug: string;
  status: Doc<"projects">["status"];
  visibility: Doc<"projects">["visibility"];
  organizationId: Id<"organizations">;
};

export const listProjects = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(v.union(v.literal("draft"), v.literal("published"))),
    visibility: v.optional(v.union(v.literal("private"), v.literal("public"))),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const status = args.status;
    const visibility = args.visibility;

    // When both filters present, use the composite index for precise results.
    // Otherwise paginate all and filter in-memory (admin tool, bounded scale).
    let result;
    if (status !== undefined && visibility !== undefined) {
      result = await ctx.db
        .query("projects")
        .withIndex("by_visibility_status", (q) =>
          q.eq("visibility", visibility).eq("status", status),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    } else {
      result = await ctx.db
        .query("projects")
        .order("desc")
        .paginate(args.paginationOpts);
    }

    const page: AdminProjectView[] = result.page
      .filter((p) => {
        if (status !== undefined && p.status !== status) return false;
        if (visibility !== undefined && p.visibility !== visibility) {
          return false;
        }
        return true;
      })
      .map((p) => ({
        _id: p._id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        visibility: p.visibility,
        organizationId: p.organizationId,
      }));

    return { ...result, page };
  },
});

export type AdminUsageView = {
  _id: Id<"usageEvents">;
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
};

/** Newest 100 usage events platform-wide via by_at index. */
export const recentUsage = query({
  args: {},
  handler: async (ctx): Promise<AdminUsageView[]> => {
    await requireAdmin(ctx);

    const events = await ctx.db
      .query("usageEvents")
      .withIndex("by_at", (q) => q.lte("at", Date.now()))
      .order("desc")
      .take(100);

    return events.map((e) => ({
      _id: e._id,
      organizationId: e.organizationId,
      projectId: e.projectId,
      endpoint: e.endpoint,
      method: e.method,
      credits: e.credits,
      status: e.status,
      latencyMs: e.latencyMs,
      keyId: e.keyId,
      at: e.at,
    }));
  },
});

/**
 * Platform admin kill-switch: force a project's visibility.
 * Notifies the owning org + fires project.visibility_changed webhook.
 */
export const setProjectVisibility = mutation({
  args: {
    projectId: v.id("projects"),
    visibility: v.union(v.literal("private"), v.literal("public")),
  },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    await requireAdmin(ctx);

    const project = await ctx.db.get(args.projectId);
    if (project === null) {
      throw new Error("Project not found");
    }

    await ctx.db.patch(args.projectId, { visibility: args.visibility });

    const org = await ctx.db.get(project.organizationId);
    if (org !== null) {
      await createNotification(ctx, {
        clerkOrgId: org.clerkOrgId,
        kind: "visibility_changed",
        title: "Project visibility changed",
        body: `Your project "${project.name}" visibility was set to ${args.visibility} by platform admin.`,
        refId: `visibility_changed:${args.projectId}:${Date.now()}`,
      });
    }

    await fireWebhookEvent(ctx, args.projectId, "project.visibility_changed", {
      projectId: args.projectId,
      visibility: args.visibility,
    });

    const updated = await ctx.db.get(args.projectId);
    if (updated === null) {
      throw new Error("Failed to load project");
    }
    return updated;
  },
});

export type AdminPublisherTransferView = {
  id: Id<"publisherTransfers">;
  publisherOrganizationId: Id<"organizations">;
  publisherOrganizationName: string;
  publisherOrganizationSlug?: string;
  stripeConnectedAccountId: string;
  amount: number;
  currency: string;
  status: Doc<"publisherTransfers">["status"];
  failureReason?: string;
  stripeTransferId?: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
};

/** Operator view of Stripe Connect transfer state, without bank details. */
export const listPublisherTransfers = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("created"),
        v.literal("pending"),
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("reversed"),
      ),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const q = ctx.db.query("publisherTransfers");
    const result = args.status
      ? await q
          .order("desc")
          .filter((qq) => qq.eq(qq.field("status"), args.status!))
          .paginate(args.paginationOpts)
      : await q.order("desc").paginate(args.paginationOpts);

    const page: AdminPublisherTransferView[] = await Promise.all(
      result.page.map(async (transfer) => {
        const organization = await ctx.db.get(transfer.publisherOrganizationId);
        return {
          id: transfer._id,
          publisherOrganizationId: transfer.publisherOrganizationId,
          publisherOrganizationName:
            organization?.name ?? "Deleted organization",
          publisherOrganizationSlug: organization?.slug,
          stripeConnectedAccountId: transfer.stripeConnectedAccountId,
          amount: transfer.amount,
          currency: transfer.currency,
          status: transfer.status,
          failureReason: transfer.failureReason,
          stripeTransferId: transfer.stripeTransferId,
          idempotencyKey: transfer.idempotencyKey,
          createdAt: transfer.createdAt,
          updatedAt: transfer.updatedAt,
        };
      }),
    );
    return { ...result, page };
  },
});

export const listFinanceReconciliationCases = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(
      v.union(
        v.literal("open"),
        v.literal("adopted"),
        v.literal("quarantined"),
        v.literal("resolved"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const result = await ctx.db
      .query("financeReconciliationCases")
      .withIndex("by_status_updated", (q) =>
        args.status === undefined
          ? q
          : q.eq("status", args.status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return result;
  },
});

async function requireAdminInAction(ctx: ActionCtx): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not authenticated");
  const configured = process.env.ADMIN_USER_IDS;
  if (configured === undefined || configured.trim() === "") {
    throw new Error("Admin access not configured");
  }
  const allowed = configured
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!allowed.includes(identity.subject))
    throw new Error("Not authorized as admin");
}

/** Retries a failed/scheduled transfer with its original Stripe idempotency key. */
export const retryPublisherTransfer = action({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (
    ctx,
    args,
  ): Promise<{ transferId: Id<"publisherTransfers"> }> => {
    await requireAdminInAction(ctx);
    const transfer = await ctx.runMutation(
      internal.payouts.getPublisherTransfer,
      {
        transferId: args.transferId,
      },
    );
    if (transfer.status === "succeeded" || transfer.status === "reversed") {
      return { transferId: transfer._id };
    }
    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    await verifyStripePlatformIdentity(stripeClient(), expectedLivemode);
    await transferToStripe(ctx, transfer);
    return { transferId: transfer._id };
  },
});

/** Explicit provider reconciliation for pre-correlation Stripe transfers. */
export const repairLegacyPublisherTransfer = action({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    transferId: Id<"publisherTransfers">;
    stripeTransferId: string;
  }> => {
    await requireAdminInAction(ctx);
    const transfer = await ctx.runMutation(
      internal.payouts.getLegacyPublisherTransferForRepair,
      { transferId: args.transferId },
    );
    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    const stripe = stripeClient();
    await verifyStripePlatformIdentity(stripe, expectedLivemode);
    const snapshot = await repairAndRetrieveStripeTransferMetadata(
      {
        ...stripe.transfers,
        listCandidates: async (destination) =>
          (await stripe.transfers.list({ destination, limit: 100 })).data,
      },
      transfer,
    );
    await ctx.runMutation(
      internal.payouts.verifyLegacyStripeTransferMetadataRepair,
      {
        transferId: transfer._id,
        stripeTransferId: snapshot.id,
        amount: snapshot.amount,
        amountReversed: snapshot.amount_reversed,
        currency: snapshot.currency,
        destination:
          typeof snapshot.destination === "string"
            ? snapshot.destination
            : (snapshot.destination?.id ?? ""),
        platformAccountId: snapshot.metadata.platformAccountId,
        correlationNonce: snapshot.metadata.correlationNonce,
        correlationHmac: snapshot.metadata.correlationHmac,
        metadataRepairVersion: Number(snapshot.metadata.metadataRepairVersion),
      },
    );
    return { transferId: transfer._id, stripeTransferId: snapshot.id };
  },
});

export const resolvePublisherTransferReconciliation = action({
  args: {
    caseId: v.id("financeReconciliationCases"),
    resolution: v.union(v.literal("adopt"), v.literal("quarantine")),
  },
  handler: async (ctx, args): Promise<{ status: string; transferId?: string }> => {
    await requireAdminInAction(ctx);
    const row = await ctx.runQuery(
      internal.admin.getFinanceReconciliationCase,
      { caseId: args.caseId },
    );
    if (row === null) throw new Error("Finance reconciliation case not found");
    if (args.resolution === "quarantine") {
      await ctx.runMutation(internal.payouts.resolveFinanceReconciliationCase, {
        caseId: args.caseId,
        status: "quarantined",
        resolution: "operator_quarantined",
      });
      return { status: "quarantined" };
    }
    if (row.kind !== "transfer" || row.transferId === undefined) {
      throw new Error("Only transfer reconciliation cases can be adopted");
    }
    const transfer = await ctx.runMutation(
      internal.payouts.getPublisherTransfer,
      { transferId: row.transferId },
    );
    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    const stripe = stripeClient();
    await verifyStripePlatformIdentity(stripe, expectedLivemode);
    let snapshot: Stripe.Transfer;
    if (transfer.stripeTransferId !== undefined) {
      snapshot = await stripe.transfers.retrieve(transfer.stripeTransferId);
    } else {
      const candidates = (
        await stripe.transfers.list({
          destination: transfer.stripeConnectedAccountId,
          limit: 100,
        })
      ).data.filter(
        (candidate) =>
          candidate.metadata.publisherTransferId === String(transfer._id) &&
          candidate.amount === transfer.amount &&
          candidate.currency.toLowerCase() === transfer.currency.toLowerCase() &&
          (typeof candidate.destination === "string"
            ? candidate.destination
            : candidate.destination?.id) === transfer.stripeConnectedAccountId,
      );
      if (candidates.length !== 1) {
        await ctx.runMutation(internal.payouts.resolveFinanceReconciliationCase, {
          caseId: args.caseId,
          status: "open",
          candidateIds: candidates.map((candidate) => candidate.id),
          resolution: "operator_review_required",
        });
        return { status: "open", transferId: String(transfer._id) };
      }
      snapshot = await stripe.transfers.retrieve(candidates[0]!.id);
    }
    await ctx.runMutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: snapshot.id,
      publisherTransferId: snapshot.metadata.publisherTransferId,
      amount: snapshot.amount,
      amountReversed: snapshot.amount_reversed,
      currency: snapshot.currency,
      destination:
        typeof snapshot.destination === "string"
          ? snapshot.destination
          : (snapshot.destination?.id ?? ""),
      platformAccountId: snapshot.metadata.platformAccountId,
      correlationNonce: snapshot.metadata.correlationNonce,
      correlationHmac: snapshot.metadata.correlationHmac,
      metadataRepairVersion:
        snapshot.metadata.metadataRepairVersion === undefined
          ? undefined
          : Number(snapshot.metadata.metadataRepairVersion),
      providerRequestId: snapshot.lastResponse?.requestId,
      failed: false,
      failureReason: undefined,
    });
    await ctx.runMutation(internal.payouts.resolveFinanceReconciliationCase, {
      caseId: args.caseId,
      status: "adopted",
      candidateIds: [snapshot.id],
      resolution: "operator_adopted_exact_provider_snapshot",
    });
    return { status: "adopted", transferId: String(transfer._id) };
  },
});

export const getFinanceReconciliationCase = query({
  args: { caseId: v.id("financeReconciliationCases") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.get(args.caseId);
  },
});

export const resolveConnectAccountReconciliation = action({
  args: {
    caseId: v.id("financeReconciliationCases"),
    resolution: v.union(v.literal("adopt"), v.literal("quarantine")),
  },
  handler: async (ctx, args): Promise<{ status: string; accountId?: string }> => {
    await requireAdminInAction(ctx);
    const row = await ctx.runQuery(
      internal.admin.getFinanceReconciliationCase,
      { caseId: args.caseId },
    );
    if (row === null || row.kind !== "account_create" || row.operationId === undefined) {
      throw new Error("Connect account reconciliation case not found");
    }
    if (args.resolution === "quarantine") {
      await ctx.runMutation(internal.payouts.resolveFinanceReconciliationCase, {
        caseId: args.caseId,
        status: "quarantined",
        resolution: "operator_quarantined",
      });
      return { status: "quarantined" };
    }
    const operation = await ctx.runQuery(
      internal.payouts.getConnectOnboardingOperation,
      { operationId: row.operationId },
    );
    if (
      operation === null ||
      operation.country === undefined ||
      operation.providerRequestFingerprint === undefined
    ) {
      throw new Error("Connect account operation lacks immutable request facts");
    }
    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    const stripe = stripeClient();
    await verifyStripePlatformIdentity(stripe, expectedLivemode);
    const accounts = await stripe.v2.core.accounts
      .list({ applied_configurations: ["recipient"], limit: 100 })
      .autoPagingToArray({ limit: 100_000 });
    const matches = accounts.filter((account) => {
      try {
        assertConnectedAccountIdentity(account, {
          clerkOrgId: operation.clerkOrgId,
          organizationId: operation.organizationId,
          expectedLivemode,
          operationId: operation.operationId,
          country: operation.country,
        });
        return true;
      } catch {
        return false;
      }
    });
    await ctx.runMutation(internal.payouts.resolveFinanceReconciliationCase, {
      caseId: args.caseId,
      status: matches.length === 1 ? "resolved" : "open",
      candidateIds: matches.map((account) => account.id).slice(0, 1_000),
      resolution:
        matches.length === 1
          ? "operator_verified_account_candidate"
          : "operator_review_required",
    });
    if (matches.length !== 1) {
      return { status: "open" };
    }
    const account = await stripe.v2.core.accounts.retrieve(matches[0]!.id, {
      include: ["configuration.recipient", "defaults", "identity", "requirements"],
    });
    assertConnectedAccountIdentity(account, {
      accountId: account.id,
      clerkOrgId: operation.clerkOrgId,
      organizationId: operation.organizationId,
      expectedLivemode,
      operationId: operation.operationId,
      country: operation.country,
    });
    const committed = await ctx.runMutation(
      internal.payouts.commitConnectAccountOperation,
      {
        organizationId: operation.organizationId,
        operationId: operation.operationId,
        stripeConnectedAccountId: account.id,
        expectedLivemode,
        platformAccountId: process.env.STRIPE_PLATFORM_ACCOUNT_ID,
      },
    );
    if (!committed.accepted) return { status: "open" };
    return { status: "resolved", accountId: account.id };
  },
});
