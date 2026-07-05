/**
 * Centralized Redis key namespace for the Polar user-scoped credits system.
 * All keys are prefixed with `zevium:` to avoid collisions with other
 * Upstash consumers (Better Auth secondary storage, app cache).
 */
const REDIS_NAMESPACE = "zevium";

export const RedisKeys = {
  /** Per-user atomic counter of consumed credits. */
  userConsumed: (userId: string) => `${REDIS_NAMESPACE}:userConsumed:${userId}`,
  /** Per-user cached `creditedUnits` from Polar (TTL 5 min). */
  creditedUnits: (userId: string) => `${REDIS_NAMESPACE}:creditedUnits:${userId}`,
  /** Set of processed Polar webhook ids (24 h TTL). */
  webhookIds: () => `${REDIS_NAMESPACE}:webhookIds`,
} as const;

export { REDIS_NAMESPACE };
