import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { add } from "./walletLedger";
import {
  ROLLUP_SHARDS,
  LATENCY_BUCKETS_MS,
  shardFor,
  TOTAL_ROLLUP_SHARDS,
  utcDay,
} from "./rollups";
import { creditsToAtoms } from "../accounting";

/** Daily netAtoms belongs to execution analytics, never to release inventory. */
export async function financialRollup(
  ctx: MutationCtx,
  earning: Doc<"publisherEarnings">,
  pendingDelta: number,
  reversedDelta: number,
  platformReversedDelta: number,
) {
  for (const dimension of ["total", "project"] as const) {
    const dimensionKey = dimension === "total" ? "all" : earning.projectId;
    const shard =
      dimension === "total" ? earning.shard : earning.shard % ROLLUP_SHARDS;
    for (const kind of ["daily", "lifetime"] as const) {
      const row =
        kind === "daily"
          ? await ctx.db
              .query("usageRollups")
              .withIndex("by_daily", (q) =>
                q
                  .eq("kind", kind)
                  .eq("scope", "publisher")
                  .eq("scopeId", earning.publisherOrganizationId)
                  .eq("day", earning.day)
                  .eq("dimension", dimension)
                  .eq("dimensionKey", dimensionKey)
                  .eq("shard", shard),
              )
              .unique()
          : await ctx.db
              .query("usageRollups")
              .withIndex("by_lifetime", (q) =>
                q
                  .eq("kind", kind)
                  .eq("scope", "publisher")
                  .eq("scopeId", earning.publisherOrganizationId)
                  .eq("dimension", dimension)
                  .eq("dimensionKey", dimensionKey)
                  .eq("shard", shard),
              )
              .unique();
      if (!row || row.kind === "lifetime_consumer_project")
        throw new Error("Missing earning rollup");
      await ctx.db.patch(row._id, {
        pendingRiskAtoms: add(row.pendingRiskAtoms, pendingDelta),
        reversedAtoms: add(row.reversedAtoms, reversedDelta),
        updatedAt: Date.now(),
      });
    }
  }
  if (platformReversedDelta)
    await platformDelta(
      ctx,
      earning.day,
      earning.shard,
      0,
      platformReversedDelta,
    );
}
async function platformDelta(
  ctx: MutationCtx,
  day: string,
  shard: number,
  breakageAtoms: number,
  reversedDelta: number,
) {
  for (const kind of ["daily", "lifetime"] as const) {
    const row =
      kind === "daily"
        ? await ctx.db
            .query("usageRollups")
            .withIndex("by_daily", (q) =>
              q
                .eq("kind", kind)
                .eq("scope", "platform")
                .eq("scopeId", "platform")
                .eq("day", day)
                .eq("dimension", "total")
                .eq("dimensionKey", "all")
                .eq("shard", shard),
            )
            .unique()
        : await ctx.db
            .query("usageRollups")
            .withIndex("by_lifetime", (q) =>
              q
                .eq("kind", kind)
                .eq("scope", "platform")
                .eq("scopeId", "platform")
                .eq("dimension", "total")
                .eq("dimensionKey", "all")
                .eq("shard", shard),
            )
            .unique();
    if (row && row.kind === "lifetime_consumer_project")
      throw new Error("Invalid platform rollup");
    const delta = {
      breakageAtoms: add(row?.breakageAtoms ?? 0, breakageAtoms),
      reversedAtoms: add(row?.reversedAtoms ?? 0, reversedDelta),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, delta);
    else {
      const common = {
        scope: "platform" as const,
        scopeId: "platform",
        dimension: "total" as const,
        dimensionKey: "all",
        shard,
        calls: 0,
        grossCredits: 0,
        netAtoms: 0,
        pendingRiskAtoms: 0,
        failedAtoms: 0,
        ...delta,
      };
      await ctx.db.insert(
        "usageRollups",
        kind === "lifetime"
          ? { ...common, kind }
          : {
              ...common,
              kind,
              day,
              success: 0,
              errors4xx: 0,
              errors5xx: 0,
              latencyHistogram: Array<number>(
                LATENCY_BUCKETS_MS.length + 1,
              ).fill(0),
            },
      );
    }
  }
}
/** Invoked in the same transaction only after a new expiry journal append. */
export async function recordBreakage(
  ctx: MutationCtx,
  refId: string,
  credits: number,
) {
  await platformDelta(
    ctx,
    utcDay(Date.now()),
    shardFor(refId, TOTAL_ROLLUP_SHARDS),
    creditsToAtoms(credits),
    0,
  );
}
