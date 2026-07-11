import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
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

/**
 * Paginated consumer call log for the org that paid (organizationId on events).
 * Index range: by_org_at. projectId/keyId filtered after the index scan.
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
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const result = await ctx.db
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
      if (args.projectId !== undefined && event.projectId !== args.projectId) {
        continue;
      }
      if (args.keyId !== undefined && event.keyId !== args.keyId) {
        continue;
      }
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
