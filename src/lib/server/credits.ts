import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";

import { db, schema } from "~/db";
import { kv } from "~/lib/server/kv";
import { CreditsRedisKey } from "~/lib/shared/credits-keys";

// Re-export for backwards compatibility
export { CreditsRedisKey };

// Validators
const PositiveIntegerSchema = z.number().int("amountCents must be a whole number").positive("amountCents must be > 0");

const UserIdSchema = z.string().min(1, "userId is required");

const OptionalStringSchema = z.string().nullable().optional();

interface LedgerEntryInput {
  userId: string;
  amountCents: number;
  type: "topup" | "deduct" | "adjust";
  reference?: string | null;
  description?: string | null;
}

interface AddInput {
  userId: string;
  amountCents: number;
  reference?: string;
  description?: string;
}

interface DeductInput {
  userId: string;
  amountCents: number;
  reason?: string;
  reference?: string;
}

async function appendLedger(entry: LedgerEntryInput) {
  await db.insert(schema.creditLedger).values({
    amountCents: entry.amountCents,
    createdAt: new Date(),
    description: entry.description ?? null,
    id: createId(),
    reference: entry.reference ?? null,
    type: entry.type,
    userId: entry.userId,
  });
}

/**
 * CreditsManager handles the mechanical operations of credit balance management.
 * It deals with the "how" (incrementing, decrementing, fetching) but not the "why" (business logic).
 */
export const CreditsManager = {
  /**
   * Get the current credit balance for a user in cents.
   */
  async getBalance(userId: string): Promise<number> {
    UserIdSchema.parse(userId);
    const key = CreditsRedisKey.balance(userId);
    const raw = await kv.get<unknown>(key);
    const n = typeof raw === "number" ? raw : Number(raw ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  },

  /**
   * Add credits to a user's balance (e.g., top-up).
   * Returns the new balance.
   */
  async add(input: AddInput): Promise<number> {
    UserIdSchema.parse(input.userId);
    PositiveIntegerSchema.parse(input.amountCents);
    OptionalStringSchema.parse(input.reference);
    OptionalStringSchema.parse(input.description);

    const key = CreditsRedisKey.balance(input.userId);
    await kv.incrby(key, input.amountCents);

    await appendLedger({
      userId: input.userId,
      amountCents: input.amountCents,
      type: "topup",
      reference: input.reference,
      description: input.description,
    });

    return this.getBalance(input.userId);
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

    const key = CreditsRedisKey.balance(input.userId);
    const script = `
      local k = KEYS[1]
      local dec = tonumber(ARGV[1])
      local current = tonumber(redis.call('GET', k) or '0')
      if current >= dec then
        local newbal = redis.call('DECRBY', k, dec)
        return newbal
      else
        return -1
      end
    `;

    const evalResult = (await kv
      // Types from @upstash/redis/cloudflare vary; coerce to broad types safely
      .eval(script as string, [key] as Array<string>, [String(input.amountCents)] as Array<unknown>)
      .catch(() => -1)) as unknown;

    const resultNum = typeof evalResult === "number" ? evalResult : Number(evalResult ?? Number.NaN);

    if (!Number.isFinite(resultNum) || resultNum < 0) {
      throw new Error("Insufficient credits");
    }

    await appendLedger({
      userId: input.userId,
      amountCents: -input.amountCents,
      type: "deduct",
      description: input.reason,
      reference: input.reference,
    });

    return Math.floor(resultNum);
  },
};
