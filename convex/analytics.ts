import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOrgMemberBySlug } from "./lib/auth";

/**
 * Time-indexed scan caps bound aggregation work on high-volume ranges.
 */
const ORG_SCAN_CAP = 5_000;
const PROJECT_SCAN_CAP = 10_000;
const RECENT_LIMIT = 20;

export type UsageEventView = {
  _id: Id<"usageEvents">;
  projectId: Id<"projects">;
  projectSlug: string | null;
  projectName: string | null;
  endpoint: string;
  method: string;
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  at: number;
};

export type OrgOverview = {
  balance: number;
  /** UTC calendar-month cycle start (ms). */
  cycleStart: number;
  /** UTC day start (ms). */
  dayStart: number;
  callsToday: number;
  creditsToday: number;
  callsCycle: number;
  creditsCycle: number;
  /**
   * Linear projection of cycle spend to month end:
   * creditsCycle / elapsedMs * cycleMs. 0 when no elapsed spend.
   */
  projectedCycleSpend: number;
  /** True when scan hit ORG_SCAN_CAP — totals may undercount. */
  truncated: boolean;
  scanCap: number;
  recent: UsageEventView[];
};

export type EndpointStats = {
  method: string;
  endpoint: string;
  calls: number;
  credits: number;
  errors4xx: number;
  errors5xx: number;
  success: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type ProjectAnalytics = {
  projectId: Id<"projects">;
  projectSlug: string;
  rangeDays: number;
  rangeStart: number;
  calls: number;
  credits: number;
  successRate: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errors4xx: number;
  errors5xx: number;
  endpoints: EndpointStats[];
  /** Daily call counts oldest→newest, length = rangeDays. CSS bar sparkline fodder. */
  callsByDay: number[];
  /** True when scan hit PROJECT_SCAN_CAP — stats may undercount. */
  truncated: boolean;
  scanCap: number;
};

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function endOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const w = rank - lo;
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w;
}

function statusClass(status: number): "ok" | "4xx" | "5xx" | "other" {
  if (status >= 200 && status < 400) return "ok";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function projectLinearSpend(
  creditsCycle: number,
  cycleStart: number,
  now: number,
): number {
  if (creditsCycle <= 0) return 0;
  const elapsed = Math.max(now - cycleStart, 1);
  const cycleMs = Math.max(endOfUtcMonth(now) - cycleStart, 1);
  return Math.round((creditsCycle / elapsed) * cycleMs);
}

/**
 * Org dashboard rollup: wallet + today/cycle usage + recent 20 events.
 * Cycle = UTC calendar month.
 */
export const orgOverview = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<OrgOverview> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    const dayStart = startOfUtcDay(now);
    const cycleStart = startOfUtcMonth(now);

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .unique();

    const scanned = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_at", (q) =>
        q
          .eq("organizationId", org._id)
          .gte("at", cycleStart)
          .lt("at", now + 1),
      )
      .order("desc")
      .take(ORG_SCAN_CAP);

    // Recent activity is independent of the UTC-month aggregation window, so
    // month boundaries never produce an empty or undersized activity list.
    const recentEvents = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_at", (q) =>
        q.eq("organizationId", org._id).lt("at", now + 1),
      )
      .order("desc")
      .take(RECENT_LIMIT);

    const truncated = scanned.length >= ORG_SCAN_CAP;

    let callsToday = 0;
    let creditsToday = 0;
    let callsCycle = 0;
    let creditsCycle = 0;

    const projectCache = new Map<
      Id<"projects">,
      { slug: string; name: string } | null
    >();

    async function resolveProject(
      projectId: Id<"projects">,
    ): Promise<{ slug: string; name: string } | null> {
      if (projectCache.has(projectId)) {
        return projectCache.get(projectId) ?? null;
      }
      const project = await ctx.db.get(projectId);
      const view =
        project === null ? null : { slug: project.slug, name: project.name };
      projectCache.set(projectId, view);
      return view;
    }

    for (const event of scanned) {
      if (event.at >= cycleStart) {
        callsCycle += 1;
        creditsCycle += event.credits;
      }
      if (event.at >= dayStart) {
        callsToday += 1;
        creditsToday += event.credits;
      }
    }

    const recent = await Promise.all(
      recentEvents.map(async (event): Promise<UsageEventView> => {
        const project = await resolveProject(event.projectId);
        return {
          _id: event._id,
          projectId: event.projectId,
          projectSlug: project?.slug ?? null,
          projectName: project?.name ?? null,
          endpoint: event.endpoint,
          method: event.method,
          credits: event.credits,
          status: event.status,
          latencyMs: event.latencyMs,
          keyId: event.keyId,
          at: event.at,
        };
      }),
    );

    return {
      balance: wallet?.balance ?? 0,
      cycleStart,
      dayStart,
      callsToday,
      creditsToday,
      callsCycle,
      creditsCycle,
      projectedCycleSpend: projectLinearSpend(creditsCycle, cycleStart, now),
      truncated,
      scanCap: ORG_SCAN_CAP,
      recent,
    };
  },
});

/**
 * Publisher project analytics for the last `rangeDays` (default 7).
 * Per-endpoint totals + latency percentiles computed in-query over capped scan.
 */
export const projectAnalytics = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
    rangeDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ProjectAnalytics | null> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (project === null) return null;

    const rawDays = args.rangeDays ?? 7;
    const rangeDays =
      Number.isFinite(rawDays) && rawDays > 0
        ? Math.min(Math.floor(rawDays), 90)
        : 7;

    const now = Date.now();
    const dayStart = startOfUtcDay(now);
    // Inclusive window: last N UTC days including today.
    const rangeStart = dayStart - (rangeDays - 1) * 86_400_000;

    const scanned = await ctx.db
      .query("usageEvents")
      .withIndex("by_project_at", (q) =>
        q
          .eq("projectId", project._id)
          .gte("at", rangeStart)
          .lt("at", now + 1),
      )
      .order("desc")
      .take(PROJECT_SCAN_CAP);

    const truncated = scanned.length >= PROJECT_SCAN_CAP;

    type Acc = {
      method: string;
      endpoint: string;
      calls: number;
      credits: number;
      errors4xx: number;
      errors5xx: number;
      success: number;
      latencies: number[];
    };

    const byEndpoint = new Map<string, Acc>();
    const allLatencies: number[] = [];
    const callsByDay = Array.from({ length: rangeDays }, () => 0);

    let calls = 0;
    let credits = 0;
    let success = 0;
    let errors4xx = 0;
    let errors5xx = 0;

    for (const event of scanned) {
      calls += 1;
      credits += event.credits;
      allLatencies.push(event.latencyMs);

      const cls = statusClass(event.status);
      if (cls === "ok") success += 1;
      else if (cls === "4xx") errors4xx += 1;
      else if (cls === "5xx") errors5xx += 1;

      const dayIdx = Math.floor((event.at - rangeStart) / 86_400_000);
      if (dayIdx >= 0 && dayIdx < rangeDays) {
        callsByDay[dayIdx] = (callsByDay[dayIdx] ?? 0) + 1;
      }

      const key = `${event.method} ${event.endpoint}`;
      let acc = byEndpoint.get(key);
      if (acc === undefined) {
        acc = {
          method: event.method,
          endpoint: event.endpoint,
          calls: 0,
          credits: 0,
          errors4xx: 0,
          errors5xx: 0,
          success: 0,
          latencies: [],
        };
        byEndpoint.set(key, acc);
      }
      acc.calls += 1;
      acc.credits += event.credits;
      acc.latencies.push(event.latencyMs);
      if (cls === "ok") acc.success += 1;
      else if (cls === "4xx") acc.errors4xx += 1;
      else if (cls === "5xx") acc.errors5xx += 1;
    }

    allLatencies.sort((a, b) => a - b);

    const endpoints: EndpointStats[] = Array.from(byEndpoint.values())
      .map((acc) => {
        const sorted = acc.latencies.slice().sort((a, b) => a - b);
        return {
          method: acc.method,
          endpoint: acc.endpoint,
          calls: acc.calls,
          credits: acc.credits,
          errors4xx: acc.errors4xx,
          errors5xx: acc.errors5xx,
          success: acc.success,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
        };
      })
      .sort((a, b) => b.calls - a.calls);

    return {
      projectId: project._id,
      projectSlug: project.slug,
      rangeDays,
      rangeStart,
      calls,
      credits,
      successRate: calls === 0 ? 0 : success / calls,
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      errors4xx,
      errors5xx,
      endpoints,
      callsByDay,
      truncated,
      scanCap: PROJECT_SCAN_CAP,
    };
  },
});
