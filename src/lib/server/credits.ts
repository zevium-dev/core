import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db, orm, schema } from "~/db";
import { withMutex } from "./mutex";

export async function getUserBalanceCents(userId: string): Promise<number> {
  const row = await db
    .select({ balanceCents: schema.creditBalance.balanceCents })
    .from(schema.creditBalance)
    .where(eq(schema.creditBalance.userId, userId))
    .then((rows) => rows.at(0));
  return row?.balanceCents ?? 0;
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
  const now = new Date();
  // Upsert balance
  await db
    .insert(schema.creditBalance)
    .values({
      userId,
      balanceCents: amountCents,
      currency: "usd",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: {
        balanceCents: sql`${schema.creditBalance.balanceCents} + ${amountCents}`,
        updatedAt: now,
      },
      target: schema.creditBalance.userId,
    });

  await appendLedger({ userId, amountCents, type: "topup", reference, description });
}

export async function deductCredits(userId: string, amountCents: number, reason?: string, reference?: string) {
  if (amountCents <= 0) throw new Error("amountCents must be > 0");
  return withMutex({ key: `credits:${userId}` }, async () => {
    const current = await getUserBalanceCents(userId);
    if (current < amountCents) {
      throw new Error("Insufficient credits");
    }
    const now = new Date();
    await db
      .insert(schema.creditBalance)
      .values({
        userId,
        balanceCents: 0,
        currency: "usd",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          balanceCents: sql`${schema.creditBalance.balanceCents} - ${amountCents}`,
          updatedAt: now,
        },
        target: schema.creditBalance.userId,
      });

    await appendLedger({
      amountCents: -amountCents,
      description: reason ?? null,
      reference: reference ?? null,
      type: "deduct",
      userId,
    });
    return { newBalanceCents: current - amountCents };
  });
}


