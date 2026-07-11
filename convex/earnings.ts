import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";

/**
 * Platform cut 5% → publishers keep 95%.
 * Mirrors packages/shared PLATFORM_CUT (0.05); local copy so convex/ stays
 * free of workspace package resolution for the control-plane bundle.
 */
const PLATFORM_CUT = 0.05;
const PUBLISHER_SHARE = 1 - PLATFORM_CUT;

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export type EarningsBucket = {
  calls: number;
  grossCredits: number;
  netCredits: number;
};

export type ProjectEarnings = {
  projectId: Id<"projects">;
  name: string;
  slug: string;
  calls: number;
  grossCredits: number;
  netCredits: number;
};

export type OrgEarnings = {
  byProject: ProjectEarnings[];
  month: EarningsBucket;
  allTime: EarningsBucket;
};

/**
 * Publisher earnings for the org that owns the projects.
 * Aggregates consumer-paid usageEvents via by_project_at.
 * Month = current UTC calendar month.
 */
export const forOrg = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<OrgEarnings> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    const monthStart = startOfUtcMonth(now);

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .collect();

    const byProject: ProjectEarnings[] = [];
    let monthCalls = 0;
    let monthGross = 0;
    let allCalls = 0;
    let allGross = 0;

    for (const project of projects) {
      const events = await ctx.db
        .query("usageEvents")
        .withIndex("by_project_at", (q) => q.eq("projectId", project._id))
        .collect();

      let calls = 0;
      let gross = 0;
      for (const event of events) {
        calls += 1;
        gross += event.credits;
        allCalls += 1;
        allGross += event.credits;
        if (event.at >= monthStart) {
          monthCalls += 1;
          monthGross += event.credits;
        }
      }

      byProject.push({
        projectId: project._id,
        name: project.name,
        slug: project.slug,
        calls,
        grossCredits: gross,
        netCredits: Math.round(gross * PUBLISHER_SHARE),
      });
    }

    // Stable: name then slug.
    byProject.sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.slug.localeCompare(b.slug);
    });

    return {
      byProject,
      month: {
        calls: monthCalls,
        grossCredits: monthGross,
        netCredits: Math.round(monthGross * PUBLISHER_SHARE),
      },
      allTime: {
        calls: allCalls,
        grossCredits: allGross,
        netCredits: Math.round(allGross * PUBLISHER_SHARE),
      },
    };
  },
});
