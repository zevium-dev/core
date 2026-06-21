import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";

import { kv } from "~/lib/server/kv";
import { CreditsRedisKey } from "~/lib/shared/credits-keys";

// Re-export for backwards compatibility
export { CreditsRedisKey };

// Validators
const OptionalStringSchema = z.string().nullable().optional();
const PositiveIntegerSchema = z.number().int("amountCents must be a whole number").positive("amountCents must be > 0");
const UserIdSchema = z.string().min(1, "userId is required");

const MIGRATE_LEGACY_BALANCE_SCRIPT = `
  local key = KEYS[1]
  local raw = redis.call('GET', key)
  if not raw then
    return 0
  end

  if string.match(raw, '^%-?%d+$') == nil then
    return 0
  end

  local num = tonumber(raw)
  if not num then
    return 0
  end

  if num < 0 then
    num = 0
  end

  num = math.floor(num)
  redis.call('DEL', key)
  redis.call('BITFIELD', key, 'SET', 'u63', 0, num)
  return 1
`;

interface AddInput {
  amountCents: number;
  description?: string;
  reference?: string;
  userId: string;
}

interface DeductInput {
  amountCents: number;
  reason?: string;
  reference?: string;
  userId: string;
}

interface LedgerEntryInput {
  amountCents: number;
  description?: null | string;
  reference?: null | string;
  type: "adjust" | "deduct" | "topup";
  userId: string;
}

async function appendLedgerToStream(entry: LedgerEntryInput) {
  const streamKey = CreditsRedisKey.ledgerStream();
  const id = createId();
  const createdAt = Date.now();

  await kv.xadd(
    streamKey,
    "*",
    {
      amountCents: String(entry.amountCents),
      createdAt: String(createdAt),
      description: entry.description ?? "",
      id,
      reference: entry.reference ?? "",
      type: entry.type,
      userId: entry.userId,
    },
    {
      trim: {
        comparison: "~",
        threshold: 100_000,
        type: "MAXLEN",
      },
    },
  );
}

async function getBalanceFromBitfield(userId: string): Promise<number> {
  const key = CreditsRedisKey.balance(userId);
  // Redis does not support `u64` in BITFIELD, but `u63` is supported and is more than enough.
  const res = await kv.bitfield(key).get("u63", 0).exec();
  const raw: unknown = Array.isArray(res) ? res.at(0) : res;
  if (raw === null || raw === undefined) return 0;
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

async function migrateBalanceIfNeeded(userId: string) {
  const key = CreditsRedisKey.balance(userId);
  await kv.eval(MIGRATE_LEGACY_BALANCE_SCRIPT, [key], []);
}

/**
 * CreditsManager handles the mechanical operations of credit balance management.
 * It deals with the "how" (incrementing, decrementing, fetching) but not the "why" (business logic).
 */
export const CreditsManager = {
  /**
   * Add credits to a user's balance (e.g., top-up).
   * Returns the new balance.
   */
  async add(input: AddInput): Promise<number> {
    UserIdSchema.parse(input.userId);
    PositiveIntegerSchema.parse(input.amountCents);
    OptionalStringSchema.parse(input.description);
    OptionalStringSchema.parse(input.reference);

    await migrateBalanceIfNeeded(input.userId);

    const key = CreditsRedisKey.balance(input.userId);
    // Atomic increment on an unsigned 63-bit integer stored as a bitfield.
    // Use OVERFLOW FAIL to avoid wraparound in the extremely unlikely case of overflow.
    const res = await kv.bitfield(key).overflow("FAIL").incrby("u63", 0, input.amountCents).exec();
    const raw: unknown = Array.isArray(res) ? res.at(0) : res;
    if (raw === null || raw === undefined) {
      throw new Error("Credit balance overflow");
    }

    const nextNum = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(nextNum) || nextNum < 0) {
      throw new Error("Credit balance overflow");
    }

    try {
      await appendLedgerToStream({
        amountCents: input.amountCents,
        description: input.description,
        reference: input.reference,
        type: "topup",
        userId: input.userId,
      });
    } catch {
      // Ignore ledger stream write failure to avoid reporting failed top-ups after balance already changed.
    }

    return Math.floor(nextNum);
  },

  /**
   * Deduct credits from a user's balance atomically.
   * Throws if insufficient credits.
   * Returns the new balance.
   */
  async deduct(input: DeductInput): Promise<number> {
    UserIdSchema.parse(input.userId);
    PositiveIntegerSchema.parse(input.amountCents);
    OptionalStringSchema.parse(input.reason);
    OptionalStringSchema.parse(input.reference);

    await migrateBalanceIfNeeded(input.userId);

    const key = CreditsRedisKey.balance(input.userId);
    const res = await kv.bitfield(key).overflow("FAIL").incrby("u63", 0, -input.amountCents).exec();

    const raw: unknown = Array.isArray(res) ? res.at(0) : res;
    // On underflow with OVERFLOW FAIL, Redis returns null.
    if (raw === null || raw === undefined) {
      throw new Error("Insufficient credits");
    }

    const nextNum = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(nextNum)) {
      throw new Error("Insufficient credits");
    }

    try {
      await appendLedgerToStream({
        amountCents: -input.amountCents,
        description: input.reason,
        reference: input.reference,
        type: "deduct",
        userId: input.userId,
      });
    } catch {
      // Ignore ledger stream write failure to avoid reporting failed deductions after balance already changed.
    }

    return Math.floor(nextNum);
  },

  /**
   * Get the current credit balance for a user in cents.
   */
  async getBalance(userId: string): Promise<number> {
    UserIdSchema.parse(userId);
    await migrateBalanceIfNeeded(userId);
    return getBalanceFromBitfield(userId);
  },
};
