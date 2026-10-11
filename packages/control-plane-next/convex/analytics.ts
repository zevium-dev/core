import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireActiveOrg, requireOrgAdmin } from "./lib/auth";
import {
  daily,
  sum,
  dayStart,
  monthStart,
  monthEnd,
  projected,
  percentile,
} from "./lib/readRollups";
import { atomsToCredits } from "./accounting";
import { utcDay } from "./money/rollups";
export const orgOverview = query({
  args: { orgSlug: v.string() },
  handler: async (ctx) => {
    const { org, claims, access } = await requireActiveOrg(ctx),
      privileged = access.capabilities.viewOrgUsage,
      now = Date.now(),
      start = monthStart(now),
      day = dayStart(now);
    const rows = await daily(
        ctx,
        "consumer",
        org._id,
        privileged ? "total" : "member",
        privileged ? "all" : claims.subject,
        start,
        day + 86400000,
      ),
      cycle = sum(rows),
      today = sum(rows.filter((r) => r.day === utcDay(now)));
    const recent = await (
      privileged
        ? ctx.db
            .query("usageEvents")
            .withIndex("by_org_time", (q) =>
              q.eq("consumerOrganizationId", org._id),
            )
        : ctx.db
            .query("usageEvents")
            .withIndex("by_org_owner_time", (q) =>
              q
                .eq("consumerOrganizationId", org._id)
                .eq("ownerUserId", claims.subject),
            )
    )
      .order("desc")
      .take(20);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_owner", (q) => q.eq("ownerKey", `org:${org.clerkOrgId}`))
      .unique();
    return {
      balance: wallet?.balance ?? 0,
      cycleStart: start,
      dayStart: day,
      callsToday: today.calls,
      creditsToday: today.grossCredits,
      callsCycle: cycle.calls,
      creditsCycle: cycle.grossCredits,
      projectedCycleSpend: projected(
        cycle.grossCredits,
        start,
        monthEnd(now),
        now,
      ),
      truncated: false,
      scanCap: 0,
      recent: recent.map((e) => ({
        _id: e._id,
        projectId: e.projectId,
        projectName: e.projectName,
        projectSlug: e.projectSlug,
        endpoint: e.endpoint,
        method: e.method,
        credits: e.credits,
        status: e.status,
        latencyMs: e.latencyMs,
        keyId: privileged
          ? (e.keyId ?? "")
          : e.keyId
            ? `…${e.keyId.slice(-4)}`
            : "",
        at: e.at,
      })),
    };
  },
});
export const projectAnalytics = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
    rangeDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (!project || project.retirement?.state === "retired") return null;
    const rangeDays = Math.max(
        1,
        Math.min(90, Math.floor(args.rangeDays ?? 7)),
      ),
      end = dayStart(Date.now()) + 86400000,
      rangeStart = end - rangeDays * 86400000;
    const rows = await daily(
        ctx,
        "publisher",
        org._id,
        "project",
        project._id,
        rangeStart,
        end,
      ),
      total = sum(rows);
    const details = await ctx.db
      .query("usageRollups")
      .withIndex("by_project_dimension_day", (q) =>
        q
          .eq("kind", "daily")
          .eq("scope", "publisher")
          .eq("scopeId", org._id)
          .eq("projectId", project._id)
          .eq("dimension", "endpoint")
          .gte("day", utcDay(rangeStart))
          .lt("day", utcDay(end)),
      )
      .order("desc")
      .take(4001);
    const endpoints = new Map<string, typeof rows>();
    for (const r of details.slice(0, 4000)) {
      if (r.kind !== "daily") continue;
      const key: unknown = JSON.parse(r.dimensionKey);
      if (!Array.isArray(key) || key[0] !== project._id) continue;
      const list = endpoints.get(r.dimensionKey) ?? [];
      list.push(r);
      endpoints.set(r.dimensionKey, list);
    }
    return {
      projectId: project._id,
      projectSlug: project.slug,
      rangeDays,
      rangeStart,
      calls: total.calls,
      credits: total.grossCredits,
      netCredits: atomsToCredits(total.netAtoms),
      successRate: total.calls ? (100 * total.success) / total.calls : 0,
      p50: percentile(total.histogram, 50),
      p95: percentile(total.histogram, 95),
      p99: percentile(total.histogram, 99),
      errors4xx: total.errors4xx,
      errors5xx: total.errors5xx,
      latencyPrecision: "histogram" as const,
      latencyOverflowLowerBoundMs: 30000,
      endpoints: [...endpoints].map(([key, rs]) => {
        const [, method, endpoint] = JSON.parse(key) as [
            string,
            string,
            string,
          ],
          s = sum(rs);
        return {
          method,
          endpoint,
          calls: s.calls,
          credits: s.grossCredits,
          success: s.success,
          errors4xx: s.errors4xx,
          errors5xx: s.errors5xx,
          p50: percentile(s.histogram, 50),
          p95: percentile(s.histogram, 95),
          p99: percentile(s.histogram, 99),
        };
      }),
      callsByDay: Array.from(
        { length: rangeDays },
        (_, i) =>
          sum(rows.filter((r) => r.day === utcDay(rangeStart + i * 86400000)))
            .calls,
      ),
      truncated: false,
      breakdownTruncated: details.length > 4000,
      scanCap: 4000,
    };
  },
});
