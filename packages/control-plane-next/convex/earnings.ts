import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import { daily, lifetime, sum, monthStart, dayStart } from "./lib/readRollups";
import { atomsToCredits } from "./accounting";
export const forOrg = query({
  args: { orgSlug: v.string(), projectSlug: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const now = Date.now();
    const all = sum(await lifetime(ctx, "publisher", org._id)),
      month = sum(
        await daily(
          ctx,
          "publisher",
          org._id,
          "total",
          "all",
          monthStart(now),
          dayStart(now) + 86400000,
        ),
      );
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        args.projectSlug
          ? q.eq("organizationId", org._id).eq("slug", args.projectSlug)
          : q.eq("organizationId", org._id),
      )
      .take(101);
    const bucket = (s: ReturnType<typeof sum>) => ({
      calls: s.calls,
      grossCredits: s.grossCredits,
      netCredits: atomsToCredits(s.netAtoms),
    });
    return {
      allTime: bucket(all),
      month: bucket(month),
      byProject: await Promise.all(
        projects.slice(0, 100).map(async (p) => ({
          projectId: p._id,
          name: p.name,
          slug: p.slug,
          ...bucket(
            sum(await lifetime(ctx, "publisher", org._id, "project", p._id)),
          ),
        })),
      ),
      projectsTruncated: projects.length > 100,
    };
  },
});
