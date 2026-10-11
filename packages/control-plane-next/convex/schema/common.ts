import { v } from "convex/values";
export const envelope = v.object({
  ciphertext: v.string(),
  iv: v.string(),
  keyVersion: v.string(),
  format: v.literal("aes-gcm-aad-v1"),
});
export const lifecycle = v.union(
  v.literal("active"),
  v.literal("grace"),
  v.literal("disabled"),
);
export const jobState = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("retry"),
  v.literal("complete"),
  v.literal("needs_review"),
);
export const lotState = v.union(
  v.literal("available"),
  v.literal("depleted"),
  v.literal("expired"),
);
export const sourceKind = v.union(
  v.literal("payment"),
  v.literal("promo"),
  v.literal("admin"),
);
export const pricingDecision = v.union(
  v.literal("listed_price"),
  v.literal("free_tier"),
  v.literal("zero_price"),
);
export const billingOutcome = v.union(
  v.literal("settled"),
  v.literal("refunded"),
  v.literal("free"),
);
export const qualityOutcome = v.union(
  v.literal("success"),
  v.literal("client_error"),
  v.literal("server_error"),
  v.literal("network_error"),
);
export const fundingSlice = v.object({
  lotId: v.id("fundingLots"),
  originLotId: v.id("fundingLots"),
  sourceRef: v.string(),
  paymentId: v.optional(v.id("payments")),
  credits: v.number(),
});
export const visibility = v.union(v.literal("private"), v.literal("public"));
export const content = v.object({
  rating: v.number(),
  body: v.optional(v.string()),
  active: v.boolean(),
  hidden: v.boolean(),
});

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
