import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fingerprint } from "../../contracts/transport";
import { drainAck } from "../../contracts/snapshots";
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
  if (wallet.gateState !== "open")
    throw new ConvexError("Wallet maintenance in progress");
  await ctx.db.patch(walletId, {
    gateState: "closing",
    gateRevision: add(wallet.gateRevision, 1),
    close: {
      id,
      reason,
      requestedAt: Date.now(),
      ...(command ? { command } : {}),
    },
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
    wallet.gateRevision !== ack.gateRevision ||
    ack.sealedAt > Date.now()
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
    wallet.gateState !== "closing" ||
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
      !org || org.archivedAt !== undefined || wallet.close?.reason === "archive"
        ? "closed"
        : "open",
    settledThroughEdgeSequence: 0,
  });
  return getWallet(ctx, walletId);
}
