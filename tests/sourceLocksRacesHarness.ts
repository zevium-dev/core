import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../convex/_generated/server";
import { moneyFixture, paidLot, eventFor, assertWallet } from "./moneyFixtures";
import { drain } from "./financeFixtures";
import { grantLot } from "../convex/money/lots";
import {
  projectAdjustment,
  reviewPayment,
  reconcilePaymentPage,
} from "../convex/money/adjustments";
import { settleOne } from "../convex/money/settle";
import type { Id } from "../convex/_generated/dataModel";
import { settlement } from "../contracts/settlement";
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const f = await moneyFixture(ctx, crypto.randomUUID(), [], 100);
    const paid = await paidLot(ctx, f.walletId, crypto.randomUUID(), 500);
    const event = await eventFor(ctx, f);
    await paidLot(ctx, f.walletId, crypto.randomUUID(), 1000);
    await grantLot(ctx, {
      walletId: f.walletId,
      sourceKind: "promo",
      sourceRef: crypto.randomUUID(),
      credits: 100,
    });
    return {
      walletId: f.walletId,
      paymentId: paid.lot.paymentId!,
      eventJson: JSON.stringify(event),
    };
  },
});
export const begin = internalMutation({
  args: { paymentId: v.id("payments"), failed: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const p = (await ctx.db.get(a.paymentId))!;
    await projectAdjustment(ctx, p._id, p.revision, {
      kind: "refund",
      status: a.failed ? "failed" : "pending",
      sourceRef: `race-review:${p._id}`,
      amountCents: 1,
    });
    const next = (await ctx.db.get(p._id))!;
    if (!a.failed && next.reconciliation.state !== "needs_review")
      await reviewPayment(ctx, next, 8);
    return next.reconciliation.generation;
  },
});
export const settle = internalMutation({
  args: { eventJson: v.string() },
  handler: (ctx, a) =>
    settleOne(ctx, settlement.parse(JSON.parse(a.eventJson))),
});
export const page = internalMutation({
  args: { paymentId: v.id("payments"), generation: v.number() },
  handler: (ctx, a) => reconcilePaymentPage(ctx, a.paymentId, a.generation),
});
export const ack = internalMutation({
  args: { walletId: v.id("wallets") },
  handler: (ctx, a) => drain(ctx, a.walletId),
});
export const audit = internalQuery({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, a) => {
    await assertWallet(ctx, a.walletId);
    return (await ctx.db.get(a.walletId))!;
  },
});
export const races = internalAction({
  args: {},
  handler: async (ctx) => {
    const seedRef = makeFunctionReference<
      "mutation",
      Record<string, never>,
      { walletId: Id<"wallets">; paymentId: Id<"payments">; eventJson: string }
    >("sourceLocksRaces:seed");
    const beginRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments">; failed?: boolean },
      number
    >("sourceLocksRaces:begin");
    const settleRef = makeFunctionReference<
      "mutation",
      { eventJson: string },
      { status: string }
    >("sourceLocksRaces:settle");
    const pageRef = makeFunctionReference<
      "mutation",
      { paymentId: Id<"payments">; generation: number },
      string
    >("sourceLocksRaces:page");
    const ackRef = makeFunctionReference<
      "mutation",
      { walletId: Id<"wallets"> }
    >("sourceLocksRaces:ack");
    const auditRef = makeFunctionReference<
      "query",
      { walletId: Id<"wallets"> },
      { balance: number; lockedCredits?: number; gateState: string }
    >("sourceLocksRaces:audit");
    const f = await ctx.runMutation(seedRef, {});
    const [generation, settled] = await Promise.all([
      ctx.runMutation(beginRef, { paymentId: f.paymentId }),
      ctx.runMutation(settleRef, { eventJson: f.eventJson }),
    ]);
    if (settled.status !== "applied")
      throw new Error("In-flight source lost during review");
    const args = { paymentId: f.paymentId, generation };
    if ((await ctx.runMutation(pageRef, args)) !== "waiting")
      throw new Error("Locked before drain");
    await ctx.runMutation(ackRef, { walletId: f.walletId });
    await Promise.all(
      Array.from({ length: 4 }, () => ctx.runMutation(pageRef, args)),
    );
    let w = await ctx.runQuery(auditRef, { walletId: f.walletId });
    if (w.balance !== 1500 || w.lockedCredits !== 400 || w.gateState !== "open")
      throw new Error("Quarantine race failed conservation");
    const [next] = await Promise.all([
      ctx.runMutation(beginRef, { paymentId: f.paymentId, failed: true }),
      ctx.runMutation(pageRef, args),
      ctx.runMutation(settleRef, { eventJson: f.eventJson }),
    ]);
    if (next !== generation + 1)
      throw new Error("Resolution generation did not advance");
    await ctx.runMutation(ackRef, { walletId: f.walletId });
    let done = false;
    for (let i = 0; i < 30; i++) {
      const pages = await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.runMutation(pageRef, {
            paymentId: f.paymentId,
            generation: next,
          }),
        ),
      );
      if (pages.every((p) => p === "done")) {
        done = true;
        break;
      }
    }
    w = await ctx.runQuery(auditRef, { walletId: f.walletId });
    if (
      !done ||
      w.balance !== 1500 ||
      w.lockedCredits !== 0 ||
      w.gateState !== "open"
    )
      throw new Error("Resolution race failed conservation");
    console.log(
      "Scoped review OCC: in-flight settle, duplicate lock pages, stale generation, final replay and unlock passed",
    );
  },
});
