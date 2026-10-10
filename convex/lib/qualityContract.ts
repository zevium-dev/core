import type { QualitySnapshotContract } from "@zevium/shared";
import { v, type Infer } from "convex/values";

export const qualityEvidence = v.object({
  specVersionId: v.id("specVersions"),
  reachabilitySampleSize: v.number(),
  reachabilityPercent: v.optional(v.number()),
  reachabilityLatencyP50Ms: v.optional(v.number()),
  insufficientReachabilityData: v.boolean(),
  apiSampleSize: v.number(),
  apiSuccessRatePercent: v.optional(v.number()),
  apiLatencyP50Ms: v.optional(v.number()),
  insufficientApiData: v.boolean(),
  lastProbeOutcome: v.optional(
    v.union(
      v.literal("healthy"),
      v.literal("http_error"),
      v.literal("timeout"),
      v.literal("dns_error"),
      v.literal("tls_error"),
      v.literal("network_error"),
      v.literal("blocked_target"),
    ),
  ),
  lastProbedAt: v.optional(v.number()),
  publishedAt: v.number(),
  updatedAt: v.number(),
});

/** Only aggregate evidence enters catalogue rows; freshness is derived on read. */
export function projectQualityEvidence(
  snapshot: Infer<typeof qualityEvidence>,
): Infer<typeof qualityEvidence> {
  return {
    specVersionId: snapshot.specVersionId,
    reachabilitySampleSize: snapshot.reachabilitySampleSize,
    reachabilityPercent: snapshot.reachabilityPercent,
    reachabilityLatencyP50Ms: snapshot.reachabilityLatencyP50Ms,
    insufficientReachabilityData: snapshot.insufficientReachabilityData,
    apiSampleSize: snapshot.apiSampleSize,
    apiSuccessRatePercent: snapshot.apiSuccessRatePercent,
    apiLatencyP50Ms: snapshot.apiLatencyP50Ms,
    insufficientApiData: snapshot.insufficientApiData,
    lastProbeOutcome: snapshot.lastProbeOutcome,
    lastProbedAt: snapshot.lastProbedAt,
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
  };
}

export const REACHABILITY_MINIMUM_SAMPLE_SIZE = 3;
export const API_MINIMUM_SAMPLE_SIZE = 20;
export const QUALITY_FRESHNESS_STALE_MS = 30 * 60 * 1000;

export function qualitySnapshotContract(
  snapshot: Infer<typeof qualityEvidence>,
  now = Date.now(),
): QualitySnapshotContract {
  const ageMs = Math.max(0, now - snapshot.updatedAt);
  return {
    reachabilitySampleSize: snapshot.reachabilitySampleSize,
    reachabilityMinimumSampleSize: REACHABILITY_MINIMUM_SAMPLE_SIZE,
    reachabilityPercent: snapshot.reachabilityPercent ?? null,
    reachabilityLatencyP50Ms: snapshot.reachabilityLatencyP50Ms ?? null,
    insufficientReachabilityData: snapshot.insufficientReachabilityData,
    apiSampleSize: snapshot.apiSampleSize,
    apiMinimumSampleSize: API_MINIMUM_SAMPLE_SIZE,
    apiSuccessRatePercent: snapshot.apiSuccessRatePercent ?? null,
    apiLatencyP50Ms: snapshot.apiLatencyP50Ms ?? null,
    insufficientApiData: snapshot.insufficientApiData,
    lastProbeOutcome: snapshot.lastProbeOutcome ?? null,
    lastProbedAt: snapshot.lastProbedAt ?? null,
    freshness: {
      publishedAt: snapshot.publishedAt,
      measuredAt: snapshot.updatedAt,
      ageMs,
      status: ageMs > QUALITY_FRESHNESS_STALE_MS ? "stale" : "fresh",
    },
  };
}
