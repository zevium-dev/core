import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  PUBLISHER_RISK_HOLD_MS,
  publisherEarningSplit,
  creditsToAtoms,
} from "../accounting";
import { add } from "./walletLedger";
export const ROLLUP_SHARDS = 16;
export const TOTAL_ROLLUP_SHARDS = 128;
export const rollupShardCount = (scope: string, dimension: string) =>
  scope === "platform" || (scope === "publisher" && dimension === "total")
    ? TOTAL_ROLLUP_SHARDS
    : ROLLUP_SHARDS;
// Inclusive upper bounds in milliseconds; final bucket contains all larger values.
export const LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
export function shardFor(ref: string, count = ROLLUP_SHARDS) {
  let hash = 2166136261;
  for (const char of ref)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % count;
}
type Usage = Doc<"usageEvents">;
type Financial = Extract<Doc<"usageRollups">, { kind: "lifetime" }>;
type Dimension = Pick<
  Financial,
  "scope" | "scopeId" | "dimension" | "dimensionKey"
>;
export async function recordEarnings(
  ctx: MutationCtx,
  event: Usage,
  acceptedAt: number,
) {
  if (
    !event.publisherOrganizationId ||
    !event.projectId ||
    event.billingOutcome === "exception"
  )
    throw new Error("Unsettled earning evidence");
  const { publisherOrganizationId, projectId } = event;
  const day = utcDay(acceptedAt),
    shard = shardFor(event.settleRefId, TOTAL_ROLLUP_SHARDS);
  let promoCostCredits = 0;
  for (const slice of event.fundingSlices) {
    const origin = await ctx.db.get(slice.originLotId);
    const suppressed =
      origin?.sourceKind === "promo" &&
      event.consumerOrganizationId === publisherOrganizationId;
    const split = suppressed
      ? { platformFeeAtoms: 0, publisherNetAtoms: 0 }
      : publisherEarningSplit(slice.credits);
    if (suppressed) promoCostCredits = add(promoCostCredits, slice.credits);
    const row = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_bucket", (q) =>
        q
          .eq("publisherOrganizationId", publisherOrganizationId)
          .eq("projectId", projectId)
          .eq("sourceRef", slice.sourceRef)
          .eq("day", day)
          .eq("shard", shard),
      )
      .unique();
    if (row) {
      if (row.state !== "pending" || row.paymentId !== slice.paymentId)
        throw new Error("Earning bucket identity conflict");
      await ctx.db.patch(row._id, {
        grossCredits: add(row.grossCredits, slice.credits),
        platformFeeAtoms: add(row.platformFeeAtoms, split.platformFeeAtoms),
        promoCostAtoms: add(
          row.promoCostAtoms ?? 0,
          suppressed ? creditsToAtoms(slice.credits) : 0,
        ),
        netAtoms: add(row.netAtoms, split.publisherNetAtoms),
        updatedAt: acceptedAt,
      });
    } else
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: publisherOrganizationId,
        projectId: projectId,
        paymentId: slice.paymentId,
        sourceRef: slice.sourceRef,
        day,
        shard,
        grossCredits: slice.credits,
        platformFeeAtoms: split.platformFeeAtoms,
        promoCostAtoms: suppressed ? creditsToAtoms(slice.credits) : 0,
        netAtoms: split.publisherNetAtoms,
        clawedBackGrossCredits: 0,
        clawedBackAtoms: 0,
        releasedAtoms: 0,
        availableAt:
          Date.parse(`${day}T00:00:00.000Z`) +
          86400000 +
          PUBLISHER_RISK_HOLD_MS,
        state: "pending",
        adjustmentGeneration: 0,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      });
  }
  // Deliberately no publisherBalances write on the settlement hot path.
  return promoCostCredits;
}
export async function recordRollups(
  ctx: MutationCtx,
  event: Usage,
  acceptedAt: number,
) {
  if (
    !event.publisherOrganizationId ||
    !event.projectId ||
    event.billingOutcome === "exception"
  )
    throw new Error("Unsettled rollup evidence");
  const { publisherOrganizationId, projectId } = event;
  const day = utcDay(event.at),
    earningDay = utcDay(acceptedAt);
  const split = publisherEarningSplit(
    event.credits - (event.promoCostCredits ?? 0),
  );
  const dimensions: Dimension[] = [
    ...(
      [
        ["total", "all"],
        ["project", projectId],
        ["endpoint", JSON.stringify([projectId, event.method, event.endpoint])],
        ...(event.ownerUserId ? [["member", event.ownerUserId]] : []),
        ...(event.keyId ? [["key", event.keyId]] : []),
      ] as [Dimension["dimension"], string][]
    ).map(([dimension, dimensionKey]) => ({
      scope: "consumer" as const,
      scopeId: event.consumerOrganizationId,
      dimension,
      dimensionKey,
    })),
    ...(
      [
        ["total", "all"],
        ["project", projectId],
        ["endpoint", JSON.stringify([projectId, event.method, event.endpoint])],
      ] as [Dimension["dimension"], string][]
    ).map(([dimension, dimensionKey]) => ({
      scope: "publisher" as const,
      scopeId: publisherOrganizationId,
      dimension,
      dimensionKey,
    })),
    {
      scope: "platform",
      scopeId: "platform",
      dimension: "total",
      dimensionKey: "all",
    },
  ];
  for (const dimension of dimensions) {
    const shard = shardFor(
      event.settleRefId,
      rollupShardCount(dimension.scope, dimension.dimension),
    );
    const net =
      dimension.scope === "publisher"
        ? split.publisherNetAtoms
        : dimension.scope === "platform"
          ? split.platformFeeAtoms
          : 0;
    const pending =
      dimension.scope === "publisher" && dimension.dimension !== "endpoint"
        ? net
        : 0;
    const lifetime = await ctx.db
      .query("usageRollups")
      .withIndex("by_lifetime", (q) =>
        q
          .eq("kind", "lifetime")
          .eq("scope", dimension.scope)
          .eq("scopeId", dimension.scopeId)
          .eq("dimension", dimension.dimension)
          .eq("dimensionKey", dimension.dimensionKey)
          .eq("shard", shard),
      )
      .unique();
    if (lifetime && lifetime.kind !== "lifetime")
      throw new Error("Rollup identity conflict");
    const common = {
      calls: add(lifetime?.calls ?? 0, 1),
      grossCredits: add(lifetime?.grossCredits ?? 0, event.credits),
      netAtoms: add(lifetime?.netAtoms ?? 0, net),
      promoCostAtoms: add(
        lifetime?.promoCostAtoms ?? 0,
        dimension.scope === "platform"
          ? creditsToAtoms(event.promoCostCredits ?? 0)
          : 0,
      ),
      pendingRiskAtoms: add(lifetime?.pendingRiskAtoms ?? 0, pending),
      updatedAt: acceptedAt,
    };
    if (lifetime) await ctx.db.patch(lifetime._id, common);
    else
      await ctx.db.insert("usageRollups", {
        ...dimension,
        shard,
        kind: "lifetime",
        ...common,
        reversedAtoms: 0,
        failedAtoms: 0,
      });
    // Execution-day metrics and acceptance-day risk inventory have distinct clocks.
    for (const rowDay of new Set(pending ? [day, earningDay] : [day])) {
      const row = await ctx.db
        .query("usageRollups")
        .withIndex("by_daily", (q) =>
          q
            .eq("kind", "daily")
            .eq("scope", dimension.scope)
            .eq("scopeId", dimension.scopeId)
            .eq("day", rowDay)
            .eq("dimension", dimension.dimension)
            .eq("dimensionKey", dimension.dimensionKey)
            .eq("shard", shard),
        )
        .unique();
      if (row && row.kind !== "daily")
        throw new Error("Rollup identity conflict");
      const count = rowDay === day ? 1 : 0;
      const histogram =
        row?.latencyHistogram.slice() ??
        Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
      const bucket = LATENCY_BUCKETS_MS.findIndex(
        (bound) => event.latencyMs <= bound,
      );
      const index = bucket < 0 ? LATENCY_BUCKETS_MS.length : bucket;
      histogram[index] = add(histogram[index], count);
      const delta = {
        calls: add(row?.calls ?? 0, count),
        grossCredits: add(row?.grossCredits ?? 0, count * event.credits),
        netAtoms: add(row?.netAtoms ?? 0, count * net),
        promoCostAtoms: add(
          row?.promoCostAtoms ?? 0,
          dimension.scope === "platform"
            ? count * creditsToAtoms(event.promoCostCredits ?? 0)
            : 0,
        ),
        pendingRiskAtoms: add(
          row?.pendingRiskAtoms ?? 0,
          rowDay === earningDay ? pending : 0,
        ),
        success: add(
          row?.success ?? 0,
          count * Number(event.qualityOutcome === "success"),
        ),
        errors4xx: add(
          row?.errors4xx ?? 0,
          count * Number(event.status >= 400 && event.status < 500),
        ),
        errors5xx: add(
          row?.errors5xx ?? 0,
          count * Number(event.status >= 500),
        ),
        latencyHistogram: histogram,
        updatedAt: acceptedAt,
      };
      if (row) await ctx.db.patch(row._id, delta);
      else
        await ctx.db.insert("usageRollups", {
          ...dimension,
          shard,
          kind: "daily",
          day: rowDay,
          ...delta,
          reversedAtoms: 0,
          failedAtoms: 0,
        });
    }
  }
  if (
    event.qualityOutcome === "success" &&
    event.billingOutcome !== "refunded" &&
    event.consumerOrganizationId !== publisherOrganizationId
  ) {
    const row = await ctx.db
      .query("usageRollups")
      .withIndex("by_consumer_project", (q) =>
        q
          .eq("kind", "lifetime_consumer_project")
          .eq("consumerOrganizationId", event.consumerOrganizationId)
          .eq("projectId", projectId),
      )
      .unique();
    if (row && row.kind !== "lifetime_consumer_project")
      throw new Error("Eligibility identity conflict");
    if (row)
      await ctx.db.patch(row._id, {
        firstSuccessAt: Math.min(row.firstSuccessAt, event.at),
        lastSuccessAt: Math.max(row.lastSuccessAt, event.at),
        successfulCalls: add(row.successfulCalls, 1),
        updatedAt: acceptedAt,
      });
    else
      await ctx.db.insert("usageRollups", {
        kind: "lifetime_consumer_project",
        consumerOrganizationId: event.consumerOrganizationId,
        projectId: projectId,
        firstSuccessAt: event.at,
        lastSuccessAt: event.at,
        successfulCalls: 1,
        noticeRevision: 0,
        updatedAt: acceptedAt,
      });
  }
}
