import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";

export type UsageListItem = {
  _id: Id<"usageEvents">;
  projectId: Id<"projects">;
  projectName: string | null;
  projectSlug: string | null;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
};

async function usageView(
  ctx: QueryCtx,
  event: {
    _id: Id<"usageEvents">;
    projectId: Id<"projects">;
    endpoint: string;
    method: string;
    credits: number;
    status: number;
    latencyMs: number;
    keyId: string;
    at: number;
  },
): Promise<UsageListItem> {
  const project = await ctx.db.get(event.projectId);
  return {
    _id: event._id,
    projectId: event.projectId,
    projectName: project?.name ?? null,
    projectSlug: project?.slug ?? null,
    endpoint: event.endpoint,
    method: event.method,
    credits: event.credits,
    status: event.status,
    latencyMs: event.latencyMs,
    keyId: event.keyId,
    at: event.at,
  };
}

/**
 * Paginated consumer call log for the org that paid (organizationId on events).
 * Billing drill-down filters use dedicated compound indexes. Additional
 * combined filters are applied within that already narrowed page.
 * Newest first.
 */
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
    projectId: v.optional(v.id("projects")),
    keyId: v.optional(v.string()),
    memberId: v.optional(v.string()),
    endpoint: v.optional(v.string()),
    method: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const memberId = args.memberId;
    const keyId = args.keyId;
    const projectId = args.projectId;
    const endpoint = args.endpoint;
    const method = args.method;
    let result;
    if (memberId !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_owner_at", (q) => {
          const base = q
            .eq("organizationId", org._id)
            .eq("ownerUserId", memberId);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) return base.gte("at", args.since);
          if (args.until !== undefined) return base.lt("at", args.until);
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    } else if (keyId !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_key_at", (q) => {
          const base = q.eq("organizationId", org._id).eq("keyId", keyId);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) return base.gte("at", args.since);
          if (args.until !== undefined) return base.lt("at", args.until);
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    } else if (projectId !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_project_at", (q) => {
          const base = q
            .eq("organizationId", org._id)
            .eq("projectId", projectId);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) return base.gte("at", args.since);
          if (args.until !== undefined) return base.lt("at", args.until);
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    } else if (endpoint !== undefined && method !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_endpoint_method_at", (q) => {
          const base = q
            .eq("organizationId", org._id)
            .eq("endpoint", endpoint)
            .eq("method", method);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) return base.gte("at", args.since);
          if (args.until !== undefined) return base.lt("at", args.until);
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    } else if (endpoint !== undefined) {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_endpoint_at", (q) => {
          const base = q.eq("organizationId", org._id).eq("endpoint", endpoint);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) return base.gte("at", args.since);
          if (args.until !== undefined) return base.lt("at", args.until);
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    } else {
      result = await ctx.db
        .query("usageEvents")
        .withIndex("by_org_at", (q) => {
          const base = q.eq("organizationId", org._id);
          if (args.since !== undefined && args.until !== undefined) {
            return base.gte("at", args.since).lt("at", args.until);
          }
          if (args.since !== undefined) {
            return base.gte("at", args.since);
          }
          if (args.until !== undefined) {
            return base.lt("at", args.until);
          }
          return base;
        })
        .order("desc")
        .paginate(args.paginationOpts);
    }

    const page: UsageListItem[] = [];
    for (const event of result.page) {
      if (args.projectId !== undefined && event.projectId !== args.projectId) {
        continue;
      }
      if (args.keyId !== undefined && event.keyId !== args.keyId) {
        continue;
      }
      if (args.endpoint !== undefined && event.endpoint !== args.endpoint) {
        continue;
      }
      if (
        args.method !== undefined &&
        event.method.toLowerCase() !== args.method.toLowerCase()
      ) {
        continue;
      }
      if (args.memberId !== undefined && event.ownerUserId !== args.memberId) {
        continue;
      }
      page.push(await usageView(ctx, event));
    }

    return {
      ...result,
      page,
    };
  },
});

/** Resolve a deep-linked usage event without depending on loaded pages. */
export const getForOrgById = query({
  args: { orgSlug: v.string(), eventId: v.string() },
  handler: async (ctx, args): Promise<UsageListItem | null> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const eventId = ctx.db.normalizeId("usageEvents", args.eventId);
    if (eventId === null) return null;
    const event = await ctx.db.get(eventId);
    if (event === null || event.organizationId !== org._id) return null;
    return await usageView(ctx, event);
  },
});
