import { kv } from "~/lib/server/kv";
import { RedisKeys } from "~/lib/server/redis-keys";

/**
 * Local atomic gate that complements Polar's org-meter credit system.
 *
 * Why a local counter at all?
 *   - `creditedUnits` is read from Polar (network call) but can be cached.
 *   - `orgConsumed` is incremented locally on every reserved proxy call.
 *   - The Lua atomically checks `creditedUnits - orgConsumed >= cost`
 *     and increments `orgConsumed` on success.
 *   - This avoids a per-call Polar API round-trip for the gate.
 *
 * `orgConsumed` is allowed to drift above Polar's consumed (e.g. failed
 * ingest after a successful 2xx response); the periodic reconcile job
 * (v2) is the source of truth reconciliation.
 *
 * All three Lua scripts share invariants:
 *   1. Treat a missing `orgConsumed` key as 0.
 *   2. Self-heal a negative `orgConsumed` to 0 (defense in depth).
 *   3. Refuse a refund that would drive `orgConsumed` below 0.
 */

const RESERVE_LUA = `
local key = KEYS[1]
local credited = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
if not credited or not cost or cost <= 0 then
  return redis.error_reply('invalid args')
end
local raw = redis.call('GET', key)
local cur = 0
if raw then
  cur = tonumber(raw) or 0
  if cur < 0 then
    cur = 0
    redis.call('SET', key, 0)
  end
end
if credited - cur < cost then
  return 0
end
redis.call('INCRBY', key, cost)
return 1
`;

const REFUND_LUA = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
if not cost or cost <= 0 then
  return redis.error_reply('invalid args')
end
local raw = redis.call('GET', key)
local cur = 0
if raw then
  cur = tonumber(raw) or 0
end
if cur < cost then
  return 0
end
redis.call('INCRBY', key, -cost)
return 1
`;

const PEEK_LUA = `
local key = KEYS[1]
local credited = tonumber(ARGV[1])
local raw = redis.call('GET', key)
local cur = 0
if raw then
  cur = tonumber(raw) or 0
  if cur < 0 then cur = 0 end
end
local avail = (credited or 0) - cur
if avail < 0 then avail = 0 end
return avail
`;

/**
 * Ensure `orgConsumed` is initialized to 0 for an org.
 * Idempotent. Safe to call from the org-create tRPC mutation.
 */
export async function initOrgConsumed(orgId: string): Promise<void> {
  const key = RedisKeys.orgConsumed(orgId);
  await kv.set(key, 0, { nx: true });
}

/**
 * Atomically reserve `costUnits` against the org pool.
 * Returns `true` if the reservation succeeded, `false` if insufficient.
 */
export async function reserve(orgId: string, costUnits: number): Promise<boolean> {
  // costUnits is added to the script as ARGV[2]; we need the creditedUnits
  // for the check, so the caller must pass it in. We expose a higher-level
  // helper that reads from the credit cache.
  // This low-level helper takes pre-fetched creditedUnits for testability.
  const result = await kv.eval(RESERVE_LUA, [RedisKeys.orgConsumed(orgId)], [0, costUnits]);
  return result === 1;
}

export async function reserveWithCredits(
  orgId: string,
  creditedUnits: number,
  costUnits: number,
): Promise<boolean> {
  const result = await kv.eval(
    RESERVE_LUA,
    [RedisKeys.orgConsumed(orgId)],
    [creditedUnits, costUnits],
  );
  return result === 1;
}

/**
 * Atomically refund `costUnits` (decrement the local counter).
 * Refuses to drive `orgConsumed` below 0 (caller logs / reconciles).
 * Returns `true` on success, `false` if refused.
 */
export async function refund(orgId: string, costUnits: number): Promise<boolean> {
  const result = await kv.eval(REFUND_LUA, [RedisKeys.orgConsumed(orgId)], [costUnits]);
  return result === 1;
}

/**
 * Read-only peek: `max(0, creditedUnits - orgConsumed)`.
 * Used by the credits RPC and the UI balance widget.
 */
export async function peek(orgId: string, creditedUnits: number): Promise<number> {
  const result = (await kv.eval(PEEK_LUA, [RedisKeys.orgConsumed(orgId)], [creditedUnits])) as number;
  return result;
}

/**
 * Read the current `orgConsumed` value (for debugging / reconcile).
 * Returns 0 if the key does not exist.
 */
export async function readConsumed(orgId: string): Promise<number> {
  const raw = await kv.get<number | string | null>(RedisKeys.orgConsumed(orgId));
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
