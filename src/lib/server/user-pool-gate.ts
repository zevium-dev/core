import { kv } from "~/lib/server/kv";
import { RedisKeys } from "~/lib/server/redis-keys";

/**
 * Local gate complementing Polar's per-user meter credit system.
 *
 * Implementation note: uses plain Redis SDK calls (get / set / incrby), NOT
 * Lua scripting. Per explicit constraint, no `EVAL` is used. Consequence:
 * the reserve "check then increment" is NOT atomic — a concurrent request
 * between the GET and the INCRBY can overspend by up to (in-flight - 1)
 * calls. This is accepted for v1 (bounded by concurrency; a reconcile job
 * that recomputes `userConsumed` from Polar's consumed is v2).
 *
 * `userConsumed` is allowed to drift above Polar's consumed (e.g. failed
 * ingest after a successful 2xx response); Polar remains the source of
 * truth.
 *
 * Shared invariants:
 *   1. A missing `userConsumed` key is treated as 0.
 *   2. A negative `userConsumed` is self-healed to 0 (defense in depth).
 *   3. A refund that would drive `userConsumed` below 0 is refused.
 */

/**
 * Read `userConsumed` as a non-negative integer, self-healing negatives to 0.
 * Throws on Redis errors (propagated to callers).
 */
async function readConsumedRaw(userId: string): Promise<number> {
  const raw = await kv.get<number | string | null>(RedisKeys.userConsumed(userId));
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) {
    // Self-heal a negative counter so the gate math can't be tricked.
    await kv.set(RedisKeys.userConsumed(userId), 0);
    return 0;
  }
  return Math.floor(n);
}

/**
 * Initialize `userConsumed` to 0 for a user. Idempotent (uses NX).
 * Safe to call from the post-signup hook or the balance RPC.
 */
export async function initUserConsumed(userId: string): Promise<void> {
  await kv.set(RedisKeys.userConsumed(userId), 0, { nx: true });
}

/**
 * Reserve `costUnits` against the user pool given `creditedUnits`.
 * Returns `true` on success, `false` if insufficient credits.
 * NOT atomic (see file note) — concurrent calls can briefly overspend.
 */
export async function reserveCredits(userId: string, creditedUnits: number, costUnits: number): Promise<boolean> {
  if (!Number.isFinite(creditedUnits) || !Number.isFinite(costUnits) || costUnits <= 0) {
    return false;
  }
  const consumed = await readConsumedRaw(userId);
  if (creditedUnits - consumed < costUnits) return false;
  await kv.incrby(RedisKeys.userConsumed(userId), costUnits);
  return true;
}

/**
 * Refund `costUnits` (decrement the local counter).
 * Refuses to drive `userConsumed` below 0 (caller logs / reconciles).
 * Returns `true` on success, `false` if refused.
 */
export async function refundCredits(userId: string, costUnits: number): Promise<boolean> {
  if (!Number.isFinite(costUnits) || costUnits <= 0) return false;
  const consumed = await readConsumedRaw(userId);
  if (consumed < costUnits) return false;
  await kv.incrby(RedisKeys.userConsumed(userId), -costUnits);
  return true;
}

/**
 * Read-only peek: `max(0, creditedUnits - userConsumed)`.
 * Used by the credits RPC / UI balance widget.
 */
export async function peekUser(userId: string, creditedUnits: number): Promise<number> {
  const consumed = await readConsumedRaw(userId);
  const credited = Number.isFinite(creditedUnits) ? creditedUnits : 0;
  return Math.max(0, credited - consumed);
}

/**
 * Read the current `userConsumed` value (for debugging / reconcile).
 * Returns 0 if the key does not exist.
 */
export async function readConsumedUser(userId: string): Promise<number> {
  return readConsumedRaw(userId);
}
