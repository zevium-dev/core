export type QualityProbeOutcome =
  | "success"
  | "http_error"
  | "timeout"
  | "dns_error"
  | "tls_error"
  | "network_error"
  | "blocked_target";

export type QualitySnapshotContract = {
  sampleSize: number;
  availabilityPercent: number | null;
  successRatePercent: number | null;
  latencyP50Ms: number | null;
  insufficientData: boolean;
  lastOutcome: QualityProbeOutcome | null;
  lastCheckedAt: number | null;
  freshness: {
    publishedAt: number;
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
