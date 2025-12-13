import { randomUUID } from "node:crypto";

import { db, schema } from "~/db";
import { kv } from "~/lib/server/kv";

export async function getUserBalanceCents(userId: string): Promise<number> {
  const key = `credits:balance:${userId}`;
  const raw = await kv.get<unknown>(key);
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export interface LedgerEntryInput {
  userId: string;
  amountCents: number;
  type: "topup" | "deduct" | "adjust";
  reference?: string | null;
  description?: string | null;
}

export async function appendLedger(entry: LedgerEntryInput) {
  await db.insert(schema.creditLedger).values({
    createdAt: new Date(),
    description: entry.description ?? null,
    id: randomUUID(),
    reference: entry.reference ?? null,
    type: entry.type,
    userId: entry.userId,
    amountCents: entry.amountCents,
  });
}

export async function addCreditsTopUp(userId: string, amountCents: number, reference?: string, description?: string) {
  if (amountCents <= 0) throw new Error("amountCents must be > 0");
  // Increment Redis balance
  const key = `credits:balance:${userId}`;
  await kv.incrby(key, amountCents);

  await appendLedger({ userId, amountCents, type: "topup", reference, description });
}

export async function deductCredits(userId: string, amountCents: number, reason?: string, reference?: string) {
  if (amountCents <= 0) throw new Error("amountCents must be > 0");
  // Atomic check-and-decrement in Redis via Lua script
  const key = `credits:balance:${userId}`;
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
    .eval(script as string, [key] as Array<string>, [String(amountCents)] as Array<unknown>)
    .catch(() => -1)) as unknown;
  const resultNum =
    typeof evalResult === "number"
      ? evalResult
      : Number(evalResult ?? Number.NaN);
  if (!Number.isFinite(resultNum) || resultNum < 0) {
    throw new Error("Insufficient credits");
  }

  await appendLedger({
    amountCents: -amountCents,
    description: reason ?? null,
    reference: reference ?? null,
    type: "deduct",
    userId,
  });
  return { newBalanceCents: Math.floor(resultNum) };
}

/**
 * Executes an API handler and deducts credits only if it resolves successfully.
 *
 * Default cost is 1 cent ($0.01) per call.
 */
export async function chargeForApiCall<Result>({
  userId,
  costCents = 1,
  execute,
  reason = "API usage",
  reference,
}: {
  userId: string;
  execute: () => Promise<Result>;
  costCents?: number;
  reason?: string;
  reference?: string;
}): Promise<Result> {
  const result = await execute();
  // Only on success do we deduct
  if (costCents > 0) {
    await deductCredits(userId, costCents, reason, reference);
  }
  return result;
}


