import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";

const USAGE_PAGE_SIZE_MAX = 50;

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

/**
 * Paginated consumer call log for the org that paid (organizationId on events).
 * Every optional filter is part of the selected index before pagination.
 * Newest first.
 */
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
    projectId: v.optional(v.id("projects")),
    keyId: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { claims, org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    if (
      args.since !== undefined &&
      (!Number.isSafeInteger(args.since) || args.since < 0)
    ) {
      throw new Error("Invalid start time");
    }
    if (
      args.until !== undefined &&
      (!Number.isSafeInteger(args.until) || args.until < 0)
    ) {
      throw new Error("Invalid end time");
    }
    if (
      args.since !== undefined &&
      args.until !== undefined &&
      args.since >= args.until
    ) {
      throw new Error("Start time must be before end time");
    }
    if (args.keyId !== undefined && args.keyId.length > 256) {
      throw new Error("Key filter is too long");
    }
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Number.isSafeInteger(args.paginationOpts.numItems)
        ? Math.min(
            Math.max(args.paginationOpts.numItems, 1),
            USAGE_PAGE_SIZE_MAX,
          )
        : USAGE_PAGE_SIZE_MAX,
      maximumRowsRead: USAGE_PAGE_SIZE_MAX + 1,
      maximumBytesRead: 256 * 1024,
    };

    const result =
      claims.orgRole !== "org:admin"
        ? args.projectId !== undefined && args.keyId !== undefined
          ? await ctx.db
              .query("usageEvents")
              .withIndex("by_org_owner_project_key_at", (q) => {
                const base = q
                  .eq("organizationId", org._id)
                  .eq("ownerUserId", claims.subject)
                  .eq("projectId", args.projectId!)
                  .eq("keyId", args.keyId!);
                if (args.since !== undefined && args.until !== undefined) {
                  return base.gte("at", args.since).lt("at", args.until);
                }
                if (args.since !== undefined) return base.gte("at", args.since);
                if (args.until !== undefined) return base.lt("at", args.until);
                return base;
              })
              .order("desc")
              .paginate(paginationOpts)
          : args.projectId !== undefined
            ? await ctx.db
                .query("usageEvents")
                .withIndex("by_org_owner_project_at", (q) => {
                  const base = q
                    .eq("organizationId", org._id)
                    .eq("ownerUserId", claims.subject)
                    .eq("projectId", args.projectId!);
                  if (args.since !== undefined && args.until !== undefined) {
                    return base.gte("at", args.since).lt("at", args.until);
                  }
                  if (args.since !== undefined)
                    return base.gte("at", args.since);
                  if (args.until !== undefined)
                    return base.lt("at", args.until);
                  return base;
                })
                .order("desc")
                .paginate(paginationOpts)
            : args.keyId !== undefined
              ? await ctx.db
                  .query("usageEvents")
                  .withIndex("by_org_owner_key_at", (q) => {
                    const base = q
                      .eq("organizationId", org._id)
                      .eq("ownerUserId", claims.subject)
                      .eq("keyId", args.keyId!);
                    if (args.since !== undefined && args.until !== undefined) {
                      return base.gte("at", args.since).lt("at", args.until);
                    }
                    if (args.since !== undefined)
                      return base.gte("at", args.since);
                    if (args.until !== undefined)
                      return base.lt("at", args.until);
                    return base;
                  })
                  .order("desc")
                  .paginate(paginationOpts)
              : await ctx.db
                  .query("usageEvents")
                  .withIndex("by_org_owner_at", (q) => {
                    const base = q
                      .eq("organizationId", org._id)
                      .eq("ownerUserId", claims.subject);
                    if (args.since !== undefined && args.until !== undefined) {
                      return base.gte("at", args.since).lt("at", args.until);
                    }
                    if (args.since !== undefined)
                      return base.gte("at", args.since);
                    if (args.until !== undefined)
                      return base.lt("at", args.until);
                    return base;
                  })
                  .order("desc")
                  .paginate(paginationOpts)
        : args.projectId !== undefined && args.keyId !== undefined
          ? await ctx.db
              .query("usageEvents")
              .withIndex("by_org_project_key_at", (q) => {
                const base = q
                  .eq("organizationId", org._id)
                  .eq("projectId", args.projectId!)
                  .eq("keyId", args.keyId!);
                if (args.since !== undefined && args.until !== undefined) {
                  return base.gte("at", args.since).lt("at", args.until);
                }
                if (args.since !== undefined) return base.gte("at", args.since);
                if (args.until !== undefined) return base.lt("at", args.until);
                return base;
              })
              .order("desc")
              .paginate(paginationOpts)
          : args.projectId !== undefined
            ? await ctx.db
                .query("usageEvents")
                .withIndex("by_org_project_at", (q) => {
                  const base = q
                    .eq("organizationId", org._id)
                    .eq("projectId", args.projectId!);
                  if (args.since !== undefined && args.until !== undefined) {
                    return base.gte("at", args.since).lt("at", args.until);
                  }
                  if (args.since !== undefined)
                    return base.gte("at", args.since);
                  if (args.until !== undefined)
                    return base.lt("at", args.until);
                  return base;
                })
                .order("desc")
                .paginate(paginationOpts)
            : args.keyId !== undefined
              ? await ctx.db
                  .query("usageEvents")
                  .withIndex("by_org_key_at", (q) => {
                    const base = q
                      .eq("organizationId", org._id)
                      .eq("keyId", args.keyId!);
                    if (args.since !== undefined && args.until !== undefined) {
                      return base.gte("at", args.since).lt("at", args.until);
                    }
                    if (args.since !== undefined)
                      return base.gte("at", args.since);
                    if (args.until !== undefined)
                      return base.lt("at", args.until);
                    return base;
                  })
                  .order("desc")
                  .paginate(paginationOpts)
              : await ctx.db
                  .query("usageEvents")
                  .withIndex("by_org_at", (q) => {
                    const base = q.eq("organizationId", org._id);
                    if (args.since !== undefined && args.until !== undefined) {
                      return base.gte("at", args.since).lt("at", args.until);
                    }
                    if (args.since !== undefined)
                      return base.gte("at", args.since);
                    if (args.until !== undefined)
                      return base.lt("at", args.until);
                    return base;
                  })
                  .order("desc")
                  .paginate(paginationOpts);

    const projectCache = new Map<
      Id<"projects">,
      { name: string; slug: string } | null
    >();

    async function resolveProject(
      projectId: Id<"projects">,
    ): Promise<{ name: string; slug: string } | null> {
      if (projectCache.has(projectId)) {
        return projectCache.get(projectId) ?? null;
      }
      const project = await ctx.db.get(projectId);
      const view =
        project === null ? null : { name: project.name, slug: project.slug };
      projectCache.set(projectId, view);
      return view;
    }

    const page: UsageListItem[] = [];
    for (const event of result.page) {
      const project = await resolveProject(event.projectId);
      page.push({
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
      });
    }

    return {
      ...result,
      page,
    };
  },
});
