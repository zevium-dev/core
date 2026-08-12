import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";
import { atomsToCredits } from "./accounting";

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
 * Publisher-facing statement reads canonical atom splits persisted alongside
 * each earning. It never replays usage rows or recomputes percentages.
 */
export const forOrg = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<OrgEarnings> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    const monthStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      1,
    );
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", org._id),
      )
      .collect();
    const rows = new Map<
      Id<"projects">,
      { calls: number; grossCredits: number; netCredits: number }
    >();
    let monthCalls = 0;
    let monthGross = 0;
    let monthNet = 0;
    let allGross = 0;
    let allNet = 0;

    for (const earning of earnings) {
      const netCredits = atomsToCredits(earning.publisherNetAtoms);
      allGross += earning.grossCredits;
      allNet += netCredits;
      if (earning.createdAt >= monthStart) {
        monthCalls += 1;
        monthGross += earning.grossCredits;
        monthNet += netCredits;
      }
      if (earning.projectId === undefined) continue;
      const row = rows.get(earning.projectId) ?? {
        calls: 0,
        grossCredits: 0,
        netCredits: 0,
      };
      row.calls += 1;
      row.grossCredits += earning.grossCredits;
      row.netCredits += netCredits;
      rows.set(earning.projectId, row);
    }

    const byProject = await Promise.all(
      [...rows.entries()].map(async ([projectId, row]) => {
        const project = await ctx.db.get(projectId);
        return {
          projectId,
          name: project?.name ?? "Unknown project",
          slug: project?.slug ?? "unknown",
          ...row,
        };
      }),
    );
    byProject.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.slug.localeCompare(right.slug),
    );
    return {
      byProject,
      month: {
        calls: monthCalls,
        grossCredits: monthGross,
        netCredits: monthNet,
      },
      allTime: {
        calls: earnings.length,
        grossCredits: allGross,
        netCredits: allNet,
      },
    };
  },
});
