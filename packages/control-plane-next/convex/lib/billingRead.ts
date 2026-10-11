import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireActiveOrg } from "./auth";
import {
  daily,
  sum,
  monthStart,
  monthEnd,
  dayStart,
  projected,
} from "./readRollups";
import { utcDay } from "../money/rollups";
export async function cycleBreakdown(ctx: QueryCtx) {
  const { org, claims, access } = await requireActiveOrg(ctx),
    privileged = access.capabilities.viewOrgUsage,
    asOf = Date.now(),
    cycleStart = monthStart(asOf),
    cycleEnd = monthEnd(asOf);
  const total = sum(
    await daily(
      ctx,
      "consumer",
      org._id,
      privileged ? "total" : "member",
      privileged ? "all" : claims.subject,
      cycleStart,
      dayStart(asOf) + 86400000,
    ),
  );
  const dimensions = ["key", "project", "endpoint", "member"] as const;
  const maps = Object.fromEntries(
    dimensions.map((d) => [
      d,
      new Map<string, { calls: number; credits: number }>(),
    ]),
  ) as Record<
    (typeof dimensions)[number],
    Map<string, { calls: number; credits: number }>
  >;
  let scanTruncated = false;
  if (privileged) {
    for (const dimension of dimensions) {
      const rows = await ctx.db
        .query("usageRollups")
        .withIndex("by_dimension_day", (q) =>
          q
            .eq("kind", "daily")
            .eq("scope", "consumer")
            .eq("scopeId", org._id)
            .eq("dimension", dimension)
            .gte("day", utcDay(cycleStart))
            .lt("day", utcDay(cycleEnd)),
        )
        .order("desc")
        .take(1501);
      scanTruncated ||= rows.length > 1500;
      for (const r of rows.slice(0, 1500))
        if (r.kind === "daily") {
          const row = maps[dimension].get(r.dimensionKey) ?? {
            calls: 0,
            credits: 0,
          };
          row.calls += r.calls;
          row.credits += r.grossCredits;
          maps[dimension].set(r.dimensionKey, row);
        }
    }
  } else {
    // Member totals are exact rollups; detail uses only this member's bounded index.
    const rows = await ctx.db
      .query("usageEvents")
      .withIndex("by_org_owner_time", (q) =>
        q
          .eq("consumerOrganizationId", org._id)
          .eq("ownerUserId", claims.subject)
          .gte("at", cycleStart)
          .lt("at", cycleEnd),
      )
      .order("desc")
      .take(1001);
    scanTruncated = rows.length > 1000;
    for (const r of rows.slice(0, 1000))
      if (r.projectId && r.billingOutcome !== "exception")
        for (const [dimension, key] of [
          ["key", r.keyId ?? ""],
          ["project", r.projectId],
          ["endpoint", JSON.stringify([r.projectId, r.method, r.endpoint])],
        ] as const) {
          const row = maps[dimension].get(key) ?? { calls: 0, credits: 0 };
          row.calls++;
          row.credits += r.credits;
          maps[dimension].set(key, row);
        }
  }
  const entries = (dimension: (typeof dimensions)[number]) =>
    [...maps[dimension]]
      .sort((a, b) => b[1].credits - a[1].credits || a[0].localeCompare(b[0]))
      .slice(0, 100);
  const projectInfo = async (id: string) => {
    const normalized = ctx.db.normalizeId("projects", id),
      p = normalized ? await ctx.db.get(normalized) : null,
      owner = p ? await ctx.db.get(p.organizationId) : null;
    return {
      projectRef: p && owner ? `${owner.publicHandle}/${p.slug}` : null,
      name: p?.name ?? "Unavailable API",
      slug: p?.slug ?? "unavailable",
    };
  };
  const byKey = await Promise.all(
    entries("key").map(async ([keyId, row]) => {
      const key = await ctx.db
        .query("apiKeys")
        .withIndex("by_key", (q) => q.eq("keyId", keyId))
        .unique();
      return {
        keyId: privileged ? keyId : `…${keyId.slice(-4)}`,
        keyName:
          key?.kind === "key" && key.organizationId === org._id
            ? (key.keyName ?? "Unnamed key")
            : "Unnamed key",
        memberId:
          privileged && key?.kind === "key" && key.organizationId === org._id
            ? key.ownerUserId
            : null,
        ...row,
      };
    }),
  );
  const byProject = await Promise.all(
    entries("project").map(async ([id, row]) => ({
      ...(await projectInfo(id)),
      ...row,
    })),
  );
  const byEndpoint = await Promise.all(
    entries("endpoint").map(async ([key, row]) => {
      const [id, method, endpoint] = JSON.parse(key) as [
          Id<"projects">,
          string,
          string,
        ],
        p = await projectInfo(id);
      return {
        projectRef: p.projectRef,
        projectName: p.name,
        projectSlug: p.slug,
        method,
        endpoint,
        ...row,
      };
    }),
  );
  const byMember = privileged
    ? await Promise.all(
        entries("member").map(async ([memberId, row]) => {
          const user = await ctx.db
            .query("users")
            .withIndex("by_clerk", (q) => q.eq("clerkUserId", memberId))
            .unique();
          return {
            memberId,
            name: user?.name ?? "Organization member",
            ...row,
          };
        }),
      )
    : [];
  return {
    access,
    scope: privileged ? ("organization" as const) : ("member" as const),
    cycleStart,
    cycleEnd,
    asOf,
    totalCalls: total.calls,
    totalCredits: total.grossCredits,
    ownCalls: privileged ? null : total.calls,
    ownCredits: privileged ? null : total.grossCredits,
    projectedCredits: projected(total.grossCredits, cycleStart, cycleEnd, asOf),
    byKey,
    byProject,
    byEndpoint,
    byMember,
    breakdownTruncated: {
      keys: maps.key.size > 100 || scanTruncated,
      projects: maps.project.size > 100 || scanTruncated,
      endpoints: maps.endpoint.size > 100 || scanTruncated,
      members: maps.member.size > 100 || scanTruncated,
    },
    scanTruncated,
    scanCap: privileged ? 6000 : 1000,
    totalsExact: true,
  };
}
