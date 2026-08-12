export type QualityProbeOutcome =
  | "healthy"
  | "http_error"
  | "timeout"
  | "dns_error"
  | "tls_error"
  | "network_error"
  | "blocked_target";

export type QualitySnapshotContract = {
  reachabilitySampleSize: number;
  reachabilityMinimumSampleSize: number;
  reachabilityPercent: number | null;
  reachabilityLatencyP50Ms: number | null;
  insufficientReachabilityData: boolean;
  apiSampleSize: number;
  apiMinimumSampleSize: number;
  apiSuccessRatePercent: number | null;
  apiLatencyP50Ms: number | null;
  insufficientApiData: boolean;
  lastProbeOutcome: QualityProbeOutcome | null;
  lastProbedAt: number | null;
  freshness: {
    publishedAt: number;
    measuredAt: number;
    ageMs: number;
    status: "fresh" | "stale";
  };
};

export type QualityIncidentContract = {
  id: string;
  version: string;
  openedAt: number;
  closedAt: number | null;
  status: "open" | "resolved" | "superseded";
  failureCount: number;
  lastOutcome: QualityProbeOutcome;
  reason: string;
  threshold: number;
  windowSize: number;
};

export type PublicReviewContract = {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string | null;
  createdAt: number;
  updatedAt: number;
  reviewerLabel: "Verified consumer";
  response: {
    body: string;
    updatedAt: number;
  } | null;
};

export type ReviewAggregateContract = {
  count: number;
  averageRating: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
};
