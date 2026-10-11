import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";
import { drainAck } from "../../contracts/snapshots";
import { internal } from "../_generated/api";
import { add, getWallet, money } from "./walletLedger";
export type Close = NonNullable<Doc<"wallets">["close"]>;
/** Control callers persist the server-issued ID before communicating with the DO. */
export async function requestClose(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  id: string,
  reason: Close["reason"],
  command?: Close["command"],
) {
  const wallet = await getWallet(ctx, walletId);
  if (wallet.close?.id === id) {
    if (
      wallet.close.reason !== reason ||
      wallet.close.command?.fingerprint !== command?.fingerprint
    )
      throw new ConvexError("Closure facts changed");
    return wallet;
  }
  if (wallet.gateState !== "open" && wallet.gateState !== "closed")
    throw new ConvexError("Wallet maintenance in progress");
  await ctx.db.patch(walletId, {
    gateState: wallet.gateState === "closed" ? "maintenance" : "closing",
    gateRevision: add(wallet.gateRevision, 1),
    close: {
      id,
      reason,
      requestedAt: Date.now(),
      ...(command ? { command } : {}),
      ...(wallet.gateState === "closed"
        ? {
            fromClosed: true,
            edgeFinalSequence: wallet.settledThroughEdgeSequence,
            settledThrough: wallet.settledThroughEdgeSequence,
            ackAt: Date.now(),
          }
        : {}),
    },
  });
  if (wallet.gateState === "open" && process.env.NEXT_GATEWAY_URL)
    await ctx.scheduler.runAfter(0, internal.edgeMaintenance.wakeWallet, {
      clerkOrgId: wallet.owner.clerkOrgId,
    });
  return getWallet(ctx, walletId);
}
/** Internal transport seam. PR 5 authenticates the DO before invoking it. Never infer ACK from a timeout. */
export async function acknowledgeDrain(ctx: MutationCtx, value: unknown) {
  const ack = drainAck.parse(value);
  if (
    !process.env.NEXT_DEPLOYMENT_ID ||
    ack.deploymentId !== process.env.NEXT_DEPLOYMENT_ID
  )
    throw new ConvexError("Wrong settlement deployment");
  const walletId = ctx.db.normalizeId("wallets", ack.walletId);
  if (!walletId) throw new ConvexError("Wallet not found");
  const wallet = await getWallet(ctx, walletId),
    close = wallet.close;
  const ackFingerprint = await fingerprint(ack);
  if (
    !close ||
    close.id !== ack.closeId ||
    close.reason !== ack.reason ||
    close.requestedAt !== ack.requestedAt ||
    wallet.ownerKey !== ack.ownerKey
  )
    throw new ConvexError("Closure evidence rejected");
  if (close.ackAt !== undefined) {
    if (close.ackFingerprint !== ackFingerprint)
      throw new ConvexError("Closure facts changed");
    // Exact old ACK can be replayed after completion; it cannot reopen or mutate the new epoch.
    if (ack.epoch !== wallet.epoch && ack.epoch + 1 !== wallet.epoch)
      throw new ConvexError("Stale wallet epoch");
    return wallet;
  }
  if (
    wallet.gateState !== "closing" ||
    wallet.epoch !== ack.epoch ||
    wallet.gateRevision !== ack.gateRevision
  )
    throw new ConvexError("Closure evidence rejected");
  if (wallet.settledThroughEdgeSequence !== ack.edgeFinalSequence)
    throw new ConvexError("Wallet finalizations are not drained");
  await ctx.db.patch(walletId, {
    close: {
      ...close,
      edgeFinalSequence: money(ack.edgeFinalSequence),
      settledThrough: ack.edgeFinalSequence,
      ackAt: Date.now(),
      ackFingerprint,
    },
  });
  return getWallet(ctx, walletId);
}
export async function requireDrained(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  closeId: string,
  reason?: Close["reason"],
) {
  const wallet = await getWallet(ctx, walletId);
  if (
    (wallet.gateState !== "closing" && wallet.gateState !== "maintenance") ||
    wallet.close?.id !== closeId ||
    wallet.close.ackAt === undefined ||
    wallet.close.edgeFinalSequence !== wallet.settledThroughEdgeSequence ||
    (reason && wallet.close.reason !== reason)
  )
    throw new ConvexError("Wallet must be frozen and drained");
  return wallet;
}
/** Called only after the owning maintenance transaction/job completes. */
export async function finishClose(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  closeId: string,
) {
  const wallet = await requireDrained(ctx, walletId, closeId);
  const org = await ctx.db.get(wallet.owner.organizationId);
  await ctx.db.patch(walletId, {
    epoch: add(wallet.epoch, 1),
    gateRevision: add(wallet.gateRevision, 1),
    gateState:
      wallet.close?.fromClosed ||
      !org ||
      org.archivedAt !== undefined ||
      wallet.close?.reason === "archive"
        ? "closed"
        : "open",
    settledThroughEdgeSequence: 0,
  });
  return getWallet(ctx, walletId);
}

/** Cancel only a drained admin command with no effects; never cancel a paged refund or dust job. */
export async function abandonClose(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  closeId: string,
) {
  const current = await getWallet(ctx, walletId);
  if (current.close?.id === closeId && current.close.abandoned) return current;
  const wallet = await requireDrained(ctx, walletId, closeId, "admin");
  if (!wallet.close?.command) throw new ConvexError("Admin command required");
  const effect = await ctx.db
    .query("walletEntries")
    .withIndex("by_admin_adjustment", (q) =>
      q
        .eq("walletId", walletId)
        .eq("adjustment.kind", "admin")
        .eq("adjustment.ref", closeId),
    )
    .first();
  if (effect) throw new ConvexError("Applied adjustment cannot be abandoned");
  await ctx.db.patch(walletId, { close: { ...wallet.close, abandoned: true } });
  return finishClose(ctx, walletId, closeId);
}
