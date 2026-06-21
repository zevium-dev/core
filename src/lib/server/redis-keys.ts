/**
 * Centralized Redis key namespace for the Polar credits system.
 * All keys are prefixed with `zevium:` to avoid collisions with other
 * Upstash consumers (Better Auth secondary storage, app cache).
 */
const REDIS_NAMESPACE = "zevium";

export const RedisKeys = {
  /** Per-org atomic counter of consumed credits. */
  orgConsumed: (orgId: string) => `${REDIS_NAMESPACE}:orgConsumed:${orgId}`,
  /** Per-org cached `creditedUnits` from Polar (TTL 5 min). */
  creditedUnits: (orgId: string) => `${REDIS_NAMESPACE}:creditedUnits:${orgId}`,
  /** Set of processed Polar webhook ids (24 h TTL). */
  webhookIds: () => `${REDIS_NAMESPACE}:webhookIds`,
} as const;

export { REDIS_NAMESPACE };
