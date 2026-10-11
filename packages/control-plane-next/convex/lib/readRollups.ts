import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { LATENCY_BUCKETS_MS, rollupShardCount, utcDay } from "../money/rollups";
export type Daily = Extract<Doc<"usageRollups">, { kind: "daily" }>;
export type Scope = "consumer" | "publisher" | "platform";
export type Dimension = Daily["dimension"];
export const monthStart = (at: number) => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const monthEnd = (at: number) => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
export const dayStart = (at: number) => Math.floor(at / 86400000) * 86400000;
export const projected = (
  credits: number,
  start: number,
  end: number,
  now: number,
) => Math.round((credits * (end - start)) / Math.max(now - start, 1));
/** Exact finite shard fan-in. Range max 90 UTC days, independent of usage volume. */
export async function daily(
  ctx: QueryCtx,
  scope: Scope,
  scopeId: string,
  dimension: Dimension,
  dimensionKey: string,
  from: number,
  to: number,
) {
  if (to - from > 90 * 86400000)
    throw new Error("Rollup range exceeds 90 days");
  const rows: Daily[] = [];
  for (let at = dayStart(from); at < to; at += 86400000) {
    const page = await ctx.db
      .query("usageRollups")
      .withIndex("by_daily", (q) =>
        q
          .eq("kind", "daily")
          .eq("scope", scope)
          .eq("scopeId", scopeId)
          .eq("day", utcDay(at))
          .eq("dimension", dimension)
          .eq("dimensionKey", dimensionKey),
      )
      .take(rollupShardCount(scope, dimension));
    for (const row of page) if (row.kind === "daily") rows.push(row);
  }
  return rows;
}
export async function lifetime(
  ctx: QueryCtx,
  scope: Scope,
  scopeId: string,
  dimension: Dimension = "total",
  dimensionKey = "all",
) {
  return ctx.db
    .query("usageRollups")
    .withIndex("by_lifetime", (q) =>
      q
        .eq("kind", "lifetime")
        .eq("scope", scope)
        .eq("scopeId", scopeId)
        .eq("dimension", dimension)
        .eq("dimensionKey", dimensionKey),
    )
    .take(rollupShardCount(scope, dimension));
}
export function sum(rows: Doc<"usageRollups">[]) {
  return rows.reduce(
    (a, r) => {
      if (r.kind !== "lifetime_consumer_project") {
        a.calls += r.calls;
        a.grossCredits += r.grossCredits;
        a.netAtoms += r.netAtoms;
        if (r.kind === "daily") {
          a.success += r.success;
          a.errors4xx += r.errors4xx;
          a.errors5xx += r.errors5xx;
          r.latencyHistogram.forEach(
            (n, i) => (a.histogram[i] = (a.histogram[i] ?? 0) + n),
          );
        }
      }
      return a;
    },
    {
      calls: 0,
      grossCredits: 0,
      netAtoms: 0,
      success: 0,
      errors4xx: 0,
      errors5xx: 0,
      histogram: Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
    },
  );
}
/** Inclusive bucket upper bound. Overflow bucket is reported at its lower bound. */
export function percentile(histogram: number[], p: number) {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let count = 0;
  for (let i = 0; i < histogram.length; i++) {
    count += histogram[i]!;
    if (count >= Math.ceil((total * p) / 100))
      return LATENCY_BUCKETS_MS[i] ?? LATENCY_BUCKETS_MS.at(-1)!;
  }
  return null;
}
