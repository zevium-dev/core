import { createNotification } from "../lib/notifications";
import { ConvexError } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";

export function money(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ConvexError("Invalid accounting amount");
  return value;
}
export function add(a: number, b: number) {
  return money(a + b);
}
export function facts<T>(value: T): T {
  // Convex optional properties are absent on disk; hash the same JSON representation.
  return JSON.parse(JSON.stringify(value)) as T;
}
export async function getWallet(
  ctx: Pick<QueryCtx, "db">,
  walletId: Id<"wallets">,
) {
  const wallet = await ctx.db.get(walletId);
  if (!wallet) throw new ConvexError("Wallet not found");
  return wallet;
}
export async function ensureWallet(
  ctx: MutationCtx,
  org: Doc<"organizations">,
) {
  const ownerKey = `org:${org.clerkOrgId}`;
  const current = await ctx.db
    .query("wallets")
    .withIndex("by_owner", (q) => q.eq("ownerKey", ownerKey))
    .unique();
  if (current) {
    if (current.owner.organizationId !== org._id)
      throw new ConvexError("Wallet owner conflict");
    return current;
  }
  const id = await ctx.db.insert("wallets", {
    ownerKey,
    owner: { kind: "org", organizationId: org._id, clerkOrgId: org.clerkOrgId },
    balance: 0,
    sequence: 0,
    promoCredits: 0,
    epoch: 1,
    gateState: "open",
    gateRevision: 1,
    settledThroughEdgeSequence: 0,
  });
  return getWallet(ctx, id);
}
type Entry = WithoutSystemFields<Doc<"walletEntries">>;
type Input<T> = T extends Entry
  ? Omit<T, "sequence" | "balanceAfter" | "createdAt" | "immutableFingerprint">
  : never;
export type EntryInput = Input<Entry>;
/** Only this function changes materialized wallet balance/sequence/promo inventory. */
export async function appendWalletEntry(
  ctx: MutationCtx,
  input: EntryInput,
  promoDelta = 0,
) {
  const immutableFingerprint = await fingerprint(
    facts({ ...input, promoDelta }),
  );
  const prior = await ctx.db
    .query("walletEntries")
    .withIndex("by_ref", (q) => q.eq("refId", input.refId))
    .unique();
  const wallet = await getWallet(ctx, input.walletId);
  if (prior) {
    if (
      prior.walletId !== input.walletId ||
      prior.immutableFingerprint !== immutableFingerprint
    )
      throw new ConvexError("Wallet reference facts changed");
    return { applied: false, wallet, entry: prior };
  }
  if (!Number.isSafeInteger(input.amount) || !Number.isSafeInteger(promoDelta))
    throw new ConvexError("Invalid accounting amount");
  if (
    (input.kind === "lot_move" && input.amount !== 0) ||
    (["grant", "promo", "restoration"].includes(input.kind) &&
      input.amount <= 0) ||
    (["usage", "reversal", "expiry"].includes(input.kind) && input.amount >= 0)
  )
    throw new ConvexError("Invalid journal direction");
  const balance = add(wallet.balance, input.amount),
    sequence = add(wallet.sequence, 1);
  const promoCredits = add(wallet.promoCredits, promoDelta);
  if (promoCredits > balance)
    throw new ConvexError("Invalid promotional balance");
  const id = await ctx.db.insert("walletEntries", {
    ...input,
    immutableFingerprint,
    sequence,
    balanceAfter: balance,
    createdAt: Date.now(),
  });
  await ctx.db.patch(wallet._id, { balance, sequence, promoCredits });
  if (wallet.balance >= 1000 && balance < 1000)
    await createNotification(ctx, {
      organizationId: wallet.owner.organizationId,
      kind: "low_balance",
      title: "Wallet balance is low",
      body: `${balance} credits remain. Add credits to keep calls running.`,
      refId: `low_balance:${wallet._id}:${sequence}`,
    });
  return {
    applied: true,
    wallet: await getWallet(ctx, wallet._id),
    entry: (await ctx.db.get(id))!,
  };
}
export function checkpoint(wallet: Doc<"wallets">) {
  return {
    clerkOrgId: wallet.owner.clerkOrgId,
    walletId: wallet._id,
    ownerKey: wallet.ownerKey,
    balance: wallet.balance,
    sequence: wallet.sequence,
    promoCredits: wallet.promoCredits,
    epoch: wallet.epoch,
    gateState: wallet.gateState,
    gateRevision: wallet.gateRevision,
    settledThroughEdgeSequence: wallet.settledThroughEdgeSequence,
    ...((wallet.gateState === "closing" ||
      wallet.gateState === "maintenance") &&
    wallet.close
      ? { closeId: wallet.close.id }
      : {}),
  };
}
