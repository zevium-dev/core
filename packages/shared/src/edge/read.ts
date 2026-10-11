import { z } from "zod";
/** v2 read wire contracts: no internal IDs, credentials, or deferred pricing rails. */
export const qualityRead = z.strictObject({
  reachabilitySampleSize: z.number().int().nonnegative(),
  reachabilityMinimumSampleSize: z.number().int().positive(),
  reachabilityPercent: z.number().min(0).max(100).nullable(),
  reachabilityLatencyP50Ms: z.number().nonnegative().nullable(),
  insufficientReachabilityData: z.boolean(),
  apiSampleSize: z.number().int().nonnegative(),
  apiMinimumSampleSize: z.number().int().positive(),
  apiSuccessRatePercent: z.number().min(0).max(100).nullable(),
  apiLatencyP50Ms: z.number().nonnegative().nullable(),
  insufficientApiData: z.boolean(),
  lastProbeOutcome: z
    .enum([
      "healthy",
      "http_error",
      "timeout",
      "dns_error",
      "tls_error",
      "network_error",
      "blocked_target",
    ])
    .nullable(),
  lastProbedAt: z.number().nullable(),
  freshness: z.strictObject({
    publishedAt: z.number(),
    measuredAt: z.number(),
    ageMs: z.number().nonnegative(),
    status: z.enum(["fresh", "stale"]),
  }),
});
export const publicListingRead = z.strictObject({
  name: z.string().max(120),
  slug: z.string().max(120),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string()).max(32),
  orgName: z.string(),
  publisherHandle: z.string(),
  publishedAt: z.number().nullable(),
  houseOperated: z.boolean(),
  pricing: z.strictObject({
    minCost: z.number().nonnegative(),
    maxCost: z.number().nonnegative(),
    endpointCount: z.number().int().positive(),
    hasFreeTier: z.boolean(),
  }),
  quality: qualityRead.nullable(),
});
export const searchRead = z.strictObject({
  items: z
    .array(publicListingRead.extend({ score: z.number().min(-1).max(1) }))
    .max(50),
  degraded: z.boolean(),
});
export type SearchRead = z.infer<typeof searchRead>;
