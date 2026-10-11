import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../convex/_generated/server";
import { internal } from "../convex/_generated/api";
import {
  moneyFixture,
  eventFor,
  assertWallet,
  type MoneyFixture,
} from "./moneyFixtures";
import { grantLot } from "../convex/money/lots";
import { settleOne, type Outcome } from "../convex/money/settle";
import { beginDustMerge, moveDustPage } from "../convex/money/dust";
import { acknowledgeDrain } from "../convex/money/barrier";
import { facts } from "../convex/money/walletLedger";
import type { Settlement } from "../contracts/settlement";
import type { Id } from "../convex/_generated/dataModel";
export const seedMoney = internalMutation({
  args: { run: v.string(), amounts: v.array(v.number()), cost: v.number() },
  handler: (ctx, args) => moneyFixture(ctx, args.run, args.amounts, args.cost),
});
export const event = internalQuery({
  args: { fixtureJson: v.string(), seq: v.number() },
  handler: (ctx, args) =>
    eventFor(ctx, JSON.parse(args.fixtureJson) as MoneyFixture, args.seq),
});
export const audit = internalQuery({
  args: { walletId: v.id("wallets") },
  handler: (ctx, args) => assertWallet(ctx, args.walletId),
});
export const grant = internalMutation({
  args: { walletId: v.id("wallets"), sourceRef: v.string() },
  handler: async (ctx, args) =>
    (await grantLot(ctx, { ...args, sourceKind: "promo", credits: 100 }))
      .applied,
});
export const ack = internalMutation({
  args: { walletId: v.id("wallets"), final: v.number() },
  handler: async (ctx, args) => {
    const w = (await ctx.db.get(args.walletId))!,
      c = w.close!;
    return (
      await acknowledgeDrain(ctx, {
        protocolVersion: 2,
        deploymentId: "next-fixture",
        walletId: w._id,
        ownerKey: w.ownerKey,
        epoch: w.epoch,
        gateRevision: w.gateRevision,
        closeId: c.id,
        requestedAt: c.requestedAt,
        reason: c.reason,
        edgeFinalSequence: args.final,
        settledThroughEdgeSequence: args.final,
        sealedAt: Date.now(),
      })
    ).close!.id;
  },
});
export const merge = internalMutation({
  args: { lotId: v.id("fundingLots"), generation: v.number() },
  handler: (ctx, args) => moveDustPage(ctx, args.lotId, args.generation),
});
export const startMerge = internalMutation({
  args: { lotId: v.id("fundingLots") },
  handler: async (ctx, args) =>
    (await beginDustMerge(ctx, args.lotId))!.merge!.generation,
});
export const measuredSettle = internalMutation({
  args: { eventJson: v.string() },
  handler: async (ctx, args) => {
    let writes = 0,
      argumentBytes = 0;
    const db = new Proxy(ctx.db, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        return (...params: unknown[]) => {
          if (
            ["insert", "patch", "replace", "delete"].includes(String(property))
          ) {
            writes++;
            argumentBytes += new TextEncoder().encode(
              JSON.stringify(facts(params)),
            ).length;
          }
          return Reflect.apply(member, target, params);
        };
      },
    });
    const outcome = await settleOne({ ...ctx, db }, JSON.parse(args.eventJson));
    return { outcome, writes, argumentBytes };
  },
});
export const races = internalAction({
  args: {},
  handler: async (ctx) => {
    const seed = makeFunctionReference<
      "mutation",
      { run: string; amounts: number[]; cost: number },
      MoneyFixture
    >("moneyRaces:seedMoney");
    const eventRef = makeFunctionReference<
      "query",
      { fixtureJson: string; seq: number },
      Settlement
    >("moneyRaces:event");
    const auditRef = makeFunctionReference<
      "query",
      { walletId: Id<"wallets"> },
      { balance: number; entries: number; lots: number }
    >("moneyRaces:audit");
    const ackRef = makeFunctionReference<
      "mutation",
      { walletId: Id<"wallets">; final: number },
      string
    >("moneyRaces:ack");
    const run = crypto.randomUUID();
    const f = await ctx.runMutation(seed, { run, amounts: [5], cost: 5 });
    const e = await ctx.runQuery(eventRef, {
      fixtureJson: JSON.stringify(f),
      seq: 1,
    });
    const settled = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.runMutation(internal.wallets.settleEvent, {
          eventJson: JSON.stringify(e),
        }),
      ),
    );
    if (
      settled.filter((r) => r.status === "applied").length !== 1 ||
      settled.filter((r) => r.status === "already_applied").length !== 7
    )
      throw new Error("Concurrent settlement replay failed");
    if ((await ctx.runQuery(auditRef, { walletId: f.walletId })).balance !== 0)
      throw new Error("Double spend");
    const grantRef = makeFunctionReference<
      "mutation",
      { walletId: Id<"wallets">; sourceRef: string },
      boolean
    >("moneyRaces:grant");
    const granted = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.runMutation(grantRef, {
          walletId: f.walletId,
          sourceRef: `grant:${run}`,
        }),
      ),
    );
    if (granted.filter(Boolean).length !== 1)
      throw new Error("Grant race failed");
    const begin = await ctx.runMutation(internal.wallets.beginDecrease, {
      walletId: f.walletId,
      credits: 100,
    });
    await ctx.runMutation(ackRef, { walletId: f.walletId, final: 1 });
    const decreased = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.runMutation(internal.wallets.applyDecrease, {
          walletId: f.walletId,
          ref: begin.closeId!,
          credits: 100,
        }),
      ),
    );
    if (decreased.some((w) => w.balance !== 0))
      throw new Error("Decrease race failed");
    await ctx.runQuery(auditRef, { walletId: f.walletId });
    // Distinct finalizations, same 5-credit inventory: only one may debit, even under hostile overlap.
    const scarce = await ctx.runMutation(seed, {
      run: `${run}-scarce`,
      amounts: [5],
      cost: 5,
    });
    const finals = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ctx.runQuery(eventRef, {
          fixtureJson: JSON.stringify(scarce),
          seq: i + 1,
        }),
      ),
    );
    const outcomes = await Promise.all(
      finals.map((e) =>
        ctx.runMutation(internal.wallets.settleEvent, {
          eventJson: JSON.stringify(e),
        }),
      ),
    );
    if (
      outcomes.filter((r) => r.status === "applied").length !== 1 ||
      (await ctx.runQuery(auditRef, { walletId: scarce.walletId })).balance !==
        0
    )
      throw new Error("Concurrent overspend");
    // Freeze can race finalization, but cannot reclaim credits until all eight finals commit.
    const barrier = await ctx.runMutation(seed, {
      run: `${run}-barrier`,
      amounts: [10],
      cost: 1,
    });
    const pending = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ctx.runQuery(eventRef, {
          fixtureJson: JSON.stringify(barrier),
          seq: i + 1,
        }),
      ),
    );
    const closing = await ctx.runMutation(internal.wallets.beginDecrease, {
      walletId: barrier.walletId,
      credits: 2,
    });
    const early = await Promise.allSettled([
      ctx.runMutation(ackRef, { walletId: barrier.walletId, final: 8 }),
      ctx.runMutation(internal.wallets.applyDecrease, {
        walletId: barrier.walletId,
        ref: closing.closeId!,
        credits: 2,
      }),
    ]);
    if (early.some((r) => r.status === "fulfilled"))
      throw new Error("Undrained reclaim accepted");
    await Promise.all(
      pending.map((e) =>
        ctx.runMutation(internal.wallets.settleEvent, {
          eventJson: JSON.stringify(e),
        }),
      ),
    );
    for (const e of pending) {
      const result = await ctx.runMutation(internal.wallets.settleEvent, {
        eventJson: JSON.stringify(e),
      });
      if (result.status === "rejected")
        throw new Error("Served finalization lost");
    }
    await ctx.runMutation(ackRef, { walletId: barrier.walletId, final: 8 });
    await ctx.runMutation(internal.wallets.applyDecrease, {
      walletId: barrier.walletId,
      ref: closing.closeId!,
      credits: 2,
    });
    await ctx.runQuery(auditRef, { walletId: barrier.walletId });
    const dust = await ctx.runMutation(seed, {
      run: `${run}-dust`,
      amounts: [1, 2],
      cost: 1,
    });
    // Use explicit ID order at equal timestamps; both are eligible dust.
    const source = [...dust.lots].sort()[0];
    const generation = await ctx.runMutation(
      makeFunctionReference<"mutation", { lotId: Id<"fundingLots"> }, number>(
        "moneyRaces:startMerge",
      ),
      { lotId: source },
    );
    await ctx.runMutation(ackRef, { walletId: dust.walletId, final: 0 });
    const moves = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.runMutation(
          makeFunctionReference<
            "mutation",
            { lotId: Id<"fundingLots">; generation: number },
            { complete: boolean; waiting: boolean }
          >("moneyRaces:merge"),
          { lotId: source, generation },
        ),
      ),
    );
    if (moves.some((m) => !m.complete)) throw new Error("Merge race failed");
    const dustAudit = await ctx.runQuery(auditRef, { walletId: dust.walletId });
    if (dustAudit.balance !== 3 || dustAudit.entries !== 3)
      throw new Error("Duplicate move");
    const worst = await ctx.runMutation(seed, {
      run: `${run}-worst`,
      amounts: Array<number>(32).fill(1),
      cost: 32,
    });
    const worstEvent = await ctx.runQuery(eventRef, {
      fixtureJson: JSON.stringify(worst),
      seq: 1,
    });
    const measured = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        { eventJson: string },
        { outcome: Outcome; writes: number; argumentBytes: number }
      >("moneyRaces:measuredSettle"),
      { eventJson: JSON.stringify(worstEvent) },
    );
    if (
      measured.outcome.status !== "applied" ||
      measured.writes > 150 ||
      measured.argumentBytes > 200000
    )
      throw new Error("Worst-case event budget failed");
    await ctx.runQuery(auditRef, { walletId: worst.walletId });
    return {
      passed: [
        "grant replay",
        "settlement replay",
        "distinct concurrent overspend",
        "drain before decrease",
        "admin replay",
        "dust replay",
        "32-source event budget",
      ],
      concurrentCallers: 8,
      measured,
    };
  },
});
