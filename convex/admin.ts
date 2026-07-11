import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isAdmin, requireAdmin } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { formatUsd } from "./payouts";
import { fireWebhookEvent } from "./webhooks";

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

export type AdminPayoutRequestView = {
  _id: Id<"payoutRequests">;
  clerkOrgId: string;
  credits: number;
  destination: string;
  status: "pending" | "paid" | "rejected";
  note?: string;
  createdAt: number;
  resolvedAt?: number;
};

/** Paginated admin payout queue result. */
export type AdminPayoutRequestsPage = {
  page: AdminPayoutRequestView[];
  isDone: boolean;
  continueCursor: string;
};

/**
 * Admin payout queue. Optional status filter uses the by_status index;
 * unfiltered scans newest-first via order("desc").
 */
export const listPayoutRequests = query({
  args: {
    status: v.optional(
      v.union(v.literal("pending"), v.literal("paid"), v.literal("rejected")),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<AdminPayoutRequestsPage> => {
    await requireAdmin(ctx);

    const q = ctx.db.query("payoutRequests");
    const result = args.status
      ? await q
          .withIndex("by_status", (qq) => qq.eq("status", args.status!))
          .order("desc")
          .paginate(args.paginationOpts)
      : await q.order("desc").paginate(args.paginationOpts);

    const page: AdminPayoutRequestView[] = result.page.map((r) => ({
      _id: r._id,
      clerkOrgId: r.clerkOrgId,
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

/**
 * Admin resolve a pending payout request: mark paid or rejected, stamp
 * resolvedAt, attach optional note. Only pending requests are resolvable.
 * Notifies the owning org (idempotent by requestId-scoped refId).
 */
export const resolvePayout = mutation({
  args: {
    requestId: v.id("payoutRequests"),
    status: v.union(v.literal("paid"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"payoutRequests">> => {
    await requireAdmin(ctx);

    const request = await ctx.db.get(args.requestId);
    if (request === null) {
      throw new Error("Payout request not found.");
    }
    if (request.status !== "pending") {
      throw new Error(
        `Request already ${request.status}. Only pending requests can be resolved.`,
      );
    }

    const note = args.note?.trim() || undefined;
    await ctx.db.patch(args.requestId, {
      status: args.status,
      note,
      resolvedAt: Date.now(),
    });

    const statusLabel = args.status === "paid" ? "paid out" : "rejected";
    await createNotification(ctx, {
      clerkOrgId: request.clerkOrgId,
      kind: "payout_resolved",
      title: `Payout ${statusLabel}`,
      body: `Your payout request for ${request.credits.toLocaleString()} credits ($${formatUsd(
        request.credits,
      )}) was ${statusLabel}${note !== undefined ? `: ${note}` : "."}`,
      refId: `payout_resolved:${args.requestId}`,
    });

    const updated = await ctx.db.get(args.requestId);
    if (updated === null) {
      throw new Error("Failed to load payout request.");
    }
    return updated;
  },
});
