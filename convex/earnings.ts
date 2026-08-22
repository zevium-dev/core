import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";
import { atomsToCredits } from "./accounting";
import { assertFinanceMigrationAllowsRuntime } from "./lib/financeMigrationGate";
import {
  assertPublisherBalanceReady,
  assertPublisherEarningReady,
} from "./lib/publisherLedger";

const MAX_STATEMENT_EARNINGS = 5_000;

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
    await assertFinanceMigrationAllowsRuntime(ctx);
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
      .take(MAX_STATEMENT_EARNINGS + 1);
    if (earnings.length > MAX_STATEMENT_EARNINGS) {
      throw new Error("Publisher statement requires paginated export");
    }
    const publisherBalance = await ctx.db
      .query("publisherBalances")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", org._id),
      )
      .unique();
    if (publisherBalance === null) {
      if (earnings.length > 0) {
        throw new Error("Publisher finance migration is not verified");
      }
    } else {
      assertPublisherBalanceReady(publisherBalance);
    }
    const rows = new Map<
      Id<"projects">,
      {
        name: string;
        slug: string;
        calls: number;
        grossCredits: number;
        netCredits: number;
      }
    >();
    let monthCalls = 0;
    let monthGross = 0;
    let monthNet = 0;
    let allGross = 0;
    let allNet = 0;

    for (const earning of earnings) {
      assertPublisherEarningReady(earning);
      const netCredits = atomsToCredits(earning.publisherNetAtoms);
      allGross += earning.grossCredits;
      allNet += netCredits;
      if (earning.createdAt >= monthStart) {
        monthCalls += 1;
        monthGross += earning.grossCredits;
        monthNet += netCredits;
      }
      if (earning.projectId === undefined) continue;
      if (
        earning.projectName === undefined ||
        earning.projectSlug === undefined
      ) {
        throw new Error("Publisher statement migration is not verified");
      }
      const row = rows.get(earning.projectId) ?? {
        name: earning.projectName,
        slug: earning.projectSlug,
        calls: 0,
        grossCredits: 0,
        netCredits: 0,
      };
      row.name = earning.projectName;
      row.slug = earning.projectSlug;
      row.calls += 1;
      row.grossCredits += earning.grossCredits;
      row.netCredits += netCredits;
      rows.set(earning.projectId, row);
    }

    const byProject = [...rows.entries()].map(([projectId, row]) => ({
      projectId,
      ...row,
    }));
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
