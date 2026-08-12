import type { QualitySnapshotContract } from "@zevium/shared";
import type { Doc } from "../_generated/dataModel";

export const REACHABILITY_MINIMUM_SAMPLE_SIZE = 3;
export const API_MINIMUM_SAMPLE_SIZE = 20;
export const QUALITY_FRESHNESS_STALE_MS = 30 * 60 * 1000;

export function qualitySnapshotContract(
  snapshot: Doc<"qualitySnapshots">,
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
