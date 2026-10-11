import { paginationOptsValidator, type PaginationOptions } from "convex/server";
import { v, ConvexError } from "convex/values";
import { query, mutation, action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { isAdmin, requireAdmin } from "./lib/auth";
import { projectDto } from "./lib/dto";
import { isActive } from "./lib/identity";
import { syncCatalogue } from "./lib/catalogue";
import { createNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import { daily, sum, monthStart, dayStart } from "./lib/readRollups";
import { prepareTransfer } from "./money/transfers";
import { openCase, caseEvidence } from "./money/reconciliationCases";
const page = (opts: PaginationOptions) => ({
  ...opts,
  numItems: Math.max(1, Math.min(50, opts.numItems)),
  maximumRowsRead: 100,
  maximumBytesRead: 512 * 1024,
});
export const isAdminQuery = query({ args: {}, handler: isAdmin });
export const platformStats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const count = async (facetKey: string) => {
      const rows = await ctx.db
        .query("catalogueIndex")
        .withIndex("by_facet", (q) =>
          q.eq("kind", "facet").eq("facetKey", facetKey),
        )
        .take(16);
      return rows.reduce((n, r) => n + (r.kind === "facet" ? r.count : 0), 0);
    };
    const orgs = await count("stats:orgs"),
      draft = await count("stats:draft"),
      published = await count("stats:published"),
      usage = sum(
        await daily(
          ctx,
          "platform",
          "platform",
          "total",
          "all",
          monthStart(Date.now()),
          dayStart(Date.now()) + 86400000,
        ),
      );
    return {
      orgs,
      projects: { draft, published },
      projectsTotal: draft + published,
      usageThisMonth: usage.calls,
      usageCapped: false,
      usageCap: 0,
    };
  },
});
export const listOrgs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("organizations")
      .order("desc")
      .paginate(page(args.paginationOpts));
    return {
      ...rows,
      page: await Promise.all(
        rows.page.map(async (org) => {
          const wallet = await ctx.db
            .query("wallets")
            .withIndex("by_owner", (q) =>
              q.eq("ownerKey", `org:${org.clerkOrgId}`),
            )
            .unique();
          return {
            handle: org.publicHandle,
            name: org.name,
            slug: org.slug,
            balance: wallet?.balance ?? 0,
          };
        }),
      ),
    };
  },
});
export const listProjects = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(v.union(v.literal("draft"), v.literal("published"))),
    visibility: v.optional(v.union(v.literal("public"), v.literal("private"))),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await (
      args.status
        ? ctx.db
            .query("projects")
            .withIndex("by_status", (q) => q.eq("status", args.status!))
        : ctx.db.query("projects")
    )
      .order("desc")
      .paginate(page(args.paginationOpts));
    return {
      ...rows,
      page: await Promise.all(
        rows.page
          .filter((p) => !args.visibility || p.visibility === args.visibility)
          .map(async (p) => {
            const org = await ctx.db.get(p.organizationId);
            return {
              handle: p.slug,
              organizationHandle: org?.publicHandle ?? "",
              organizationName: org?.name ?? "Unavailable publisher",
              name: p.name,
              slug: p.slug,
              status: p.status,
              visibility: p.visibility,
            };
          }),
      ),
    };
  },
});
export const recentUsage = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("usageEvents")
      .withIndex("by_at")
      .order("desc")
      .take(100);
    return rows.map((e) => ({
      _id: e._id,
      organizationId: e.consumerOrganizationId,
      projectId: e.projectId,
      endpoint: e.endpoint,
      method: e.method,
      credits: e.credits,
      status: e.status,
      latencyMs: e.latencyMs,
      keyId: e.keyId ?? "",
      at: e.at,
    }));
  },
});
export const setProjectVisibility = mutation({
  args: {
    organizationHandle: v.string(),
    projectSlug: v.string(),
    visibility: v.union(v.literal("private"), v.literal("public")),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const org = await ctx.db
        .query("organizations")
        .withIndex("by_handle", (q) =>
          q.eq("publicHandle", args.organizationHandle),
        )
        .unique(),
      project = org
        ? await ctx.db
            .query("projects")
            .withIndex("by_org_slug", (q) =>
              q.eq("organizationId", org._id).eq("slug", args.projectSlug),
            )
            .unique()
        : null;
    if (
      !project ||
      !org ||
      !(await isActive(ctx, org)) ||
      project.retirement?.state === "retired"
    )
      throw new ConvexError("Project not found");
    if (
      args.visibility === "public" &&
      (!project.latestVersionId ||
        project.qualityStatus !== "active" ||
        project.retirement)
    )
      throw new ConvexError(
        "Resolve publication, retirement or quality issues before making this project public",
      );
    if (project.visibility === args.visibility) return projectDto(project);
    await ctx.db.patch(project._id, {
      visibility: args.visibility,
      desiredVisibility: args.visibility,
      discoverable: args.visibility === "public" && project.endpointCount > 0,
      revision: project.revision + 1,
    });
    const after = (await ctx.db.get(project._id))!;
    await syncCatalogue(ctx, project, after);
    await createNotification(ctx, {
      organizationId: org._id,
      kind: "visibility_changed",
      title: "Project visibility changed",
      body: `A Zevium admin made ${project.name} ${args.visibility}.`,
      refId: `visibility:${project._id}:${after.revision}`,
    });
    await fireWebhookEvent(ctx, project._id, "project.visibility_changed", {
      projectId: project._id,
      visibility: args.visibility,
    });
    return projectDto(after);
  },
});
export const listPublisherTransfers = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(
      v.union(
        v.literal("created"),
        v.literal("pending"),
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("reversed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = args.status
      ? ctx.db
          .query("publisherTransfers")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
      : ctx.db.query("publisherTransfers");
    const rows = await source.order("desc").paginate(page(args.paginationOpts));
    return {
      ...rows,
      page: await Promise.all(
        rows.page.map(async (t) => {
          const org = await ctx.db.get(t.publisherOrganizationId);
          return {
            id: t._id,
            publisherOrganizationId: t.publisherOrganizationId,
            publisherOrganizationName: org?.name ?? "Unavailable publisher",
            publisherOrganizationSlug: org?.slug,
            stripeConnectedAccountId: t.destination,
            amount: t.amountCents,
            currency: t.currency,
            status: t.status,
            failureReason: t.failureCode,
            stripeTransferId: t.stripeTransferId,
            idempotencyKey: t.idempotencyKey,
            dispatchState: t.dispatchState,
            dispatchAttemptCount: t.attempts,
            reconciliationReason: t.failureCode,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          };
        }),
      ),
    };
  },
});
export const prepareRetry = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const t = await ctx.db.get(args.transferId);
    if (!t) throw new ConvexError("Transfer not found");
    if (t.status !== "failed") return t._id;
    const operationId = `operator-retry:${t._id}`,
      existing = await ctx.db
        .query("financeReconciliationCases")
        .withIndex("by_operation", (q) =>
          q.eq("rowKind", "case").eq("operationId", operationId),
        )
        .unique();
    if (existing?.rowKind === "case" && existing.transferId)
      return existing.transferId;
    if (t.dispatchState !== "failed")
      throw new ConvexError("Resolve the unknown transfer outcome first");
    const org = await ctx.db.get(t.publisherOrganizationId);
    if (!org) throw new ConvexError("Publisher not found");
    const id = await prepareTransfer(ctx, org),
      caseId = await openCase(ctx, {
        kind: "transfer",
        operationId,
        transferId: id,
        organizationId: org._id,
        reason: "Operator retry after definitive transfer failure",
      });
    await caseEvidence(ctx, caseId, "provider_request", `prior:${t._id}`);
    await ctx.db.patch(caseId, {
      status: "resolved",
      resolution: "New transfer allocated after definitive failure",
    });
    return id;
  },
});
export const retryPublisherTransfer = action({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args): Promise<{ transferId: string }> => {
    await requireAdmin(ctx);
    const transferId = await ctx.runMutation(internal.admin.prepareRetry, args);
    await ctx.runAction(internal.payouts.dispatch, { id: transferId });
    return { transferId };
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
    const rows = await ctx.db
      .query("financeReconciliationCases")
      .withIndex("by_status_updated", (q) =>
        args.status
          ? q.eq("rowKind", "case").eq("status", args.status)
          : q.eq("rowKind", "case"),
      )
      .order("desc")
      .paginate(page(args.paginationOpts));
    return {
      ...rows,
      page: await Promise.all(
        rows.page.map(async (row) => ({
          ...row,
          transferAmountCents:
            row.rowKind === "case" && row.transferId
              ? ((await ctx.db.get(row.transferId))?.amountCents ?? null)
              : null,
        })),
      ),
    };
  },
});
export const getFinanceReconciliationCase = query({
  args: { caseId: v.id("financeReconciliationCases") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.caseId);
    return row?.rowKind === "case"
      ? {
          ...row,
          transferAmountCents: row.transferId
            ? ((await ctx.db.get(row.transferId))?.amountCents ?? null)
            : null,
        }
      : null;
  },
});
