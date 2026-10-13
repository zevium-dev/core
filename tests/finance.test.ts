import { measure } from "./measureDb";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import Stripe from "stripe";
import { harness, type Harness } from "./helpers";
import {
  financeFixture,
  prepareFinanceFixture,
  drain,
  PLATFORM,
} from "./financeFixtures";
import { eventFor, assertWallet } from "./moneyFixtures";
import { projectPaid } from "../convex/billing";
import {
  projectAdjustment,
  reconcilePaymentPage,
  type AdjustmentFact,
  principalForCumulative,
} from "../convex/money/adjustments";
import {
  releaseEarning,
  appendPublisherEntry,
} from "../convex/money/publisherLedger";
import {
  prepareTransfer,
  claimTransfer,
  projectTransfer,
  transferFailure,
  transferScan,
} from "../convex/money/transfers";
import { requestClose, finishClose } from "../convex/money/barrier";
import { grantLot } from "../convex/money/lots";
import { beginDustMerge, moveDustPage } from "../convex/money/dust";
import { internal } from "../convex/_generated/api";
import { NOW, SECRET, organization } from "./fixtures";
import type { Id } from "../convex/_generated/dataModel";
import {
  accountPage,
  commitAccount,
  ACCOUNT_REPLAY_MS,
} from "../convex/connect";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_STRIPE_SECRET_KEY", ["sk", "test", "fixture"].join("_"));
  vi.stubEnv("NEXT_STRIPE_PLATFORM_ACCOUNT_ID", PLATFORM);
  vi.stubEnv("NEXT_STRIPE_WEBHOOK_SECRET", "fixture-signing-secret");
  vi.stubEnv("NEXT_STRIPE_CONNECT_WEBHOOK_SECRET", "fixture-connect-secret");
  vi.stubEnv("NEXT_STRIPE_V2_WEBHOOK_SECRET", "fixture-v2-secret");
  vi.stubEnv(
    "NEXT_ADMISSION_KEYS",
    JSON.stringify({ current: "k1", keys: { k1: SECRET } }),
  );
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Tests must not access Stripe network");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function adjust(
  t: Harness,
  paymentId: Id<"payments">,
  fact: AdjustmentFact,
) {
  return t.run(async (ctx) => {
    const p = (await ctx.db.get(paymentId))!;
    await projectAdjustment(ctx, paymentId, p.revision, fact);
    return (await ctx.db.get(paymentId))!.reconciliation.generation;
  });
}
async function complete(t: Harness, paymentId: Id<"payments">, limit = 10000) {
  for (let i = 0; i < limit; i++) {
    const p = (await t.run((ctx) => ctx.db.get(paymentId)))!;
    const result = await t.run((ctx) =>
      reconcilePaymentPage(ctx, paymentId, p.reconciliation.generation),
    );
    if (result === "done") return i + 1;
    if (result === "waiting") await t.run((ctx) => drain(ctx, p.walletId));
  }
  throw new Error("Reconciliation did not finish");
}
async function spend(
  t: Harness,
  f: Awaited<ReturnType<typeof financeFixture>>,
  seq = 1,
) {
  const e = await t.run((ctx) => eventFor(ctx, f, seq));
  expect(
    (
      await t.mutation(internal.wallets.settleEvent, {
        eventJson: JSON.stringify(e),
      })
    ).status,
  ).toBe("applied");
}
async function auditPublisher(t: Harness) {
  await t.run(async (ctx) => {
    const earnings = await ctx.db.query("publisherEarnings").collect(),
      entries = await ctx.db.query("publisherLedgerEntries").collect(),
      balances = await ctx.db.query("publisherBalances").collect();
    for (const e of earnings) {
      expect(e.netAtoms).toBe(e.grossCredits * 9500);
      const held = e.state === "pending" ? e.netAtoms - e.clawedBackAtoms : 0;
      expect(e.releasedAtoms + held + e.clawedBackAtoms).toBe(e.netAtoms);
    }
    for (const b of balances) {
      const es = entries.filter(
        (e) => e.publisherOrganizationId === b.publisherOrganizationId,
      );
      expect(es.reduce((n, e) => n + e.availableDeltaAtoms, 0)).toBe(
        b.availableAtoms,
      );
      expect(es.reduce((n, e) => n + e.allocatedDeltaAtoms, 0)).toBe(
        b.allocatedAtoms,
      );
      expect(es.reduce((n, e) => n + e.paidDeltaAtoms, 0)).toBe(b.paidAtoms);
      expect(es.reduce((n, e) => n + (e.reversedDeltaAtoms ?? 0), 0)).toBe(
        b.reversedAtoms,
      );
      expect(es.map((e) => e.sequence).sort((a, b) => a - b)).toEqual(
        Array.from({ length: es.length }, (_, i) => i + 1),
      );
    }
    const usage = await ctx.db.query("usageEvents").collect();
    expect(earnings.reduce((n, e) => n + e.netAtoms, 0)).toBe(
      usage.reduce((n, e) => n + e.credits * 9500, 0),
    );
  });
}
describe("verified payment accounting", () => {
  it("grants principal once, preserves actual-minus-charged variance, rejects altered Checkout facts", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    for (let i = 0; i < 4; i++)
      expect(await t.run((ctx) => projectPaid(ctx, f.paid))).toBe(f.paymentId);
    for (const patch of [
      { customerId: "other" },
      { amountCents: 1000 },
      { chargeId: "other" },
      {
        lines: [{ priceId: "wrong", quantity: 1 as const, amountCents: 1020 }],
      },
      { lines: [...f.paid.lines, ...f.paid.lines] },
    ])
      await expect(
        t.run((ctx) => projectPaid(ctx, { ...f.paid, ...patch })),
      ).rejects.toThrow(/./);
    const p = (await t.run((ctx) => ctx.db.get(f.paymentId)))!;
    expect(p.processingFeeVarianceCents).toBe(15);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      100000,
    );
    expect(
      await t.run((ctx) => ctx.db.query("fundingLotSources").collect()),
    ).toHaveLength(1);
  });
  it("reserves pending full-paid refund, restores canceled sources exactly, preserves promo", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceRef: "promo",
        sourceKind: "promo",
        credits: 10000,
      }),
    );
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "pending",
      sourceRef: "re_full",
      amountCents: 1020,
    });
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.balance).toBe(
      110000,
    );
    await complete(t, f.paymentId);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      10000,
    );
    const a = (
      await t.run((ctx) => ctx.db.query("paymentAdjustments").collect())
    )[0];
    expect(a.principalCents).toBe(1000);
    expect(a.feeCents).toBe(20);
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "canceled",
      sourceRef: "re_full",
      amountCents: 1020,
    });
    await complete(t, f.paymentId);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      110000,
    );
  });
  it("partial plus final refunds conserve every principal and fee cent", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    for (const [i, cents] of [1, 509, 510].entries()) {
      await adjust(t, f.paymentId, {
        kind: "refund",
        status: "succeeded",
        sourceRef: `re_${i}`,
        amountCents: cents,
      });
      await complete(t, f.paymentId);
    }
    const a = await t.run((ctx) =>
      ctx.db.query("paymentAdjustments").collect(),
    );
    expect(a.reduce((n, a) => n + a.principalCents, 0)).toBe(1000);
    expect(a.reduce((n, a) => n + a.feeCents, 0)).toBe(20);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      0,
    );
    expect(
      principalForCumulative(1020, {
        amountPaidCents: 1020,
        creditFaceValueCents: 1000,
      }),
    ).toBe(1000);
  });
  it("requires funds movements, handles reinstatement before withdrawal, caps overlapping sources", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    await spend(t, f);
    await adjust(t, f.paymentId, {
      kind: "dispute",
      status: "lost",
      sourceRef: "dp",
      amountCents: 1020,
    });
    await complete(t, f.paymentId);
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.effectiveReversedCredits,
    ).toBe(0);
    await adjust(t, f.paymentId, {
      kind: "dispute",
      status: "open",
      sourceRef: "dp",
      amountCents: 1020,
      movement: "withdrawal",
    });
    await complete(t, f.paymentId);
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "pending",
      sourceRef: "re",
      amountCents: 510,
    });
    await complete(t, f.paymentId);
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.effectiveReversedCredits,
    ).toBe(100000);
    await adjust(t, f.paymentId, {
      kind: "dispute",
      status: "won",
      sourceRef: "dp",
      amountCents: 1020,
      movement: "reinstatement",
    });
    await complete(t, f.paymentId);
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.effectiveReversedCredits,
    ).toBe(50000);
    await adjust(t, f.paymentId, {
      kind: "dispute",
      status: "open",
      sourceRef: "out-of-order",
      amountCents: 510,
      movement: "reinstatement",
    });
    await adjust(t, f.paymentId, {
      kind: "dispute",
      status: "open",
      sourceRef: "out-of-order",
      amountCents: 510,
      movement: "withdrawal",
    });
    await complete(t, f.paymentId);
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.effectiveReversedCredits,
    ).toBe(50000);
    await auditPublisher(t);
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
  it("queues behind a dust/admin close and maintains an archived wallet without another DO ACK", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    await t.run((ctx) =>
      requestClose(ctx, f.walletId, "dust-owner", "dust_merge"),
    );
    const gen = await adjust(t, f.paymentId, {
      kind: "refund",
      status: "pending",
      sourceRef: "re",
      amountCents: 1020,
    });
    expect(
      await t.run((ctx) => reconcilePaymentPage(ctx, f.paymentId, gen)),
    ).toBe("waiting");
    await t.run(async (ctx) => {
      await ctx.db.patch(f.consumer, { archivedAt: Date.now() });
      await drain(ctx, f.walletId);
      await finishClose(ctx, f.walletId, "dust-owner");
    });
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateState).toBe(
      "closed",
    );
    await t.run((ctx) => reconcilePaymentPage(ctx, f.paymentId, gen));
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateState).toBe(
      "maintenance",
    );
    await complete(t, f.paymentId);
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateState).toBe(
      "closed",
    );
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      0,
    );
  });
  it("refund follows moved original money and never another payment", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "moved", 99901));
    await spend(t, f);
    const second = await t.run(async (ctx) => {
      const intent = (await ctx.db.get(
        ctx.db.normalizeId("checkoutIntents", f.paid.intentId)!,
      ))!;
      const { _id, _creationTime, ...fields } = intent;
      const id = await ctx.db.insert("checkoutIntents", {
        ...fields,
        sessionId: undefined,
        paymentIntentId: undefined,
        status: "open",
      });
      return projectPaid(ctx, {
        ...f.paid,
        intentId: id,
        sessionId: "cs_second",
        paymentIntentId: "pi_second",
        chargeId: "ch_second",
      });
    });
    const lot = (await t.run((ctx) =>
      ctx.db
        .query("fundingLots")
        .withIndex("by_payment", (q) => q.eq("paymentId", f.paymentId))
        .unique(),
    ))!;
    const merge = await t.run((ctx) => beginDustMerge(ctx, lot._id));
    expect(merge).not.toBeNull();
    await t.run((ctx) => drain(ctx, f.walletId));
    await t.run((ctx) => moveDustPage(ctx, lot._id, merge!.merge!.generation));
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "succeeded",
      sourceRef: "re_moved",
      amountCents: 1020,
    });
    await complete(t, f.paymentId);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      100000,
    );
    const sources = await t.run((ctx) =>
      ctx.db
        .query("fundingLotSources")
        .withIndex("by_payment", (q) => q.eq("paymentId", second))
        .collect(),
    );
    expect(sources.reduce((n, s) => n + s.reversedCredits, 0)).toBe(0);
    await auditPublisher(t);
  });
  it("release uses acceptance-day risk inventory, then refunds create publisher liability after payment", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "release", 100000, 0));
    await spend(t, f);
    const e = (
      await t.run((ctx) => ctx.db.query("publisherEarnings").collect())
    )[0];
    vi.setSystemTime(e.availableAt - 1);
    expect(await t.run((ctx) => releaseEarning(ctx, e._id))).toBe(false);
    vi.setSystemTime(e.availableAt);
    expect(await t.run((ctx) => releaseEarning(ctx, e._id))).toBe(true);
    expect(await t.run((ctx) => releaseEarning(ctx, e._id))).toBe(false);
    // $9.50 is below minimum; a second ordinary earned payment supplies the remaining amount.
    const g = await t.run((ctx) =>
      financeFixture(ctx, "second-earned", 100000, 0),
    );
    await t.run((ctx) =>
      ctx.db.patch(g.project, { organizationId: f.publisher }),
    );
    g.publisher = f.publisher;
    await spend(t, g);
    const second = (
      await t.run((ctx) =>
        ctx.db
          .query("publisherEarnings")
          .withIndex("by_payment", (q) => q.eq("paymentId", g.paymentId))
          .collect(),
      )
    )[0];
    vi.setSystemTime(second.availableAt);
    await t.run((ctx) => releaseEarning(ctx, second._id));
    const tid = await t.run(async (ctx) =>
      prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
    );
    const transfer = (await t.run((ctx) => claimTransfer(ctx, tid)))!;
    await t.run((ctx) =>
      projectTransfer(
        ctx,
        tid,
        {
          id: "tr_paid",
          amount: transfer.amountCents,
          currency: "usd",
          destination: transfer.destination,
          livemode: false,
          platformAccountId: PLATFORM,
          nonce: transfer.operationNonce,
          fingerprint: transfer.requestFingerprint,
          reversedCents: 0,
        },
        transfer.leaseToken,
      ),
    );
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "succeeded",
      sourceRef: "re_paid",
      amountCents: 1000,
    });
    await complete(t, f.paymentId);
    const b = (await t.run((ctx) =>
      ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", f.publisher),
        )
        .unique(),
    ))!;
    expect(b.availableAtoms).toBe(-950000000);
    expect(b.paidAtoms).toBe(1900000000);
    await auditPublisher(t);
    await expect(
      t.run(async (ctx) =>
        prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
      ),
    ).rejects.toThrow("Minimum payout");
  });
  it("superseded generations cannot apply more effects", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    const old = await adjust(t, f.paymentId, {
      kind: "refund",
      status: "pending",
      sourceRef: "re",
      amountCents: 1020,
    });
    await t.run((ctx) => drain(ctx, f.walletId));
    for (let i = 0; i < 4; i++)
      await t.run((ctx) => reconcilePaymentPage(ctx, f.paymentId, old));
    await adjust(t, f.paymentId, {
      kind: "refund",
      status: "failed",
      sourceRef: "re",
      amountCents: 1020,
    });
    expect(
      await t.run((ctx) => reconcilePaymentPage(ctx, f.paymentId, old)),
    ).toBe("done");
    await complete(t, f.paymentId);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      100000,
    );
  });
});
describe("PR 4 review regressions", () => {
  it("preserves generation and projections for status-only changes, with stale-revision no-op before CAS", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    const fact = {
      kind: "refund",
      status: "pending",
      sourceRef: "re_status",
      amountCents: 510,
    } as const;
    const generation = await adjust(t, f.paymentId, fact);
    await complete(t, f.paymentId);
    const before = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
    expect(await adjust(t, f.paymentId, { ...fact, status: "succeeded" })).toBe(
      generation,
    );
    const rows = await t.run((ctx) =>
      ctx.db.query("paymentAdjustments").collect(),
    );
    expect(rows[0].effectiveCredits).toBe(50000);
    expect(rows[0].appliedWalletCredits).toBe(50000);
    await t.run((ctx) =>
      projectAdjustment(ctx, f.paymentId, 0, { ...fact, status: "succeeded" }),
    );
    await expect(
      t.run((ctx) =>
        projectAdjustment(ctx, f.paymentId, 0, { ...fact, status: "failed" }),
      ),
    ).rejects.toThrow("refetch");
    expect(await t.run((ctx) => ctx.db.get(f.walletId))).toEqual(before);
  });
  it("bounds restoration reads by open reversals after repeated exposure generations", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "restore-bounds", 20000));
    await spend(t, f);
    let totalScanned = 0;
    for (let cycle = 0; cycle < 12; cycle++) {
      for (const status of ["pending", "failed"] as const) {
        const generation = await adjust(t, f.paymentId, {
          kind: "refund",
          sourceRef: "re_cycles",
          amountCents: 1020,
          status,
        });
        await t.run((ctx) => drain(ctx, f.walletId));
        let scanned = 0;
        for (let page = 0; page < 50; page++) {
          const measured = await t.run((ctx) =>
            measure(ctx, (ctx) =>
              reconcilePaymentPage(ctx, f.paymentId, generation),
            ),
          );
          scanned += measured.readRowsByIndex.by_unrestored ?? 0;
          if (measured.result === "done") break;
          expect(page).toBeLessThan(49);
        }
        expect(scanned).toBe(status === "pending" ? 0 : 2);
        totalScanned += scanned;
        await t.run((ctx) => assertWallet(ctx, f.walletId));
        await auditPublisher(t);
      }
    }
    expect(totalScanned).toBe(24);
    const reversals = await t.run((ctx) =>
      ctx.db.query("walletEntries").collect(),
    );
    expect(
      reversals.filter(
        (e) => e.kind === "reversal" && e.restoredAt !== undefined,
      ),
    ).toHaveLength(12);
  });
  it("escalates once, waits for drain, and reopens with only affected sources locked", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    const generation = await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_error",
      amountCents: 1020,
      status: "pending",
    });
    await t.mutation(internal.billing.reconcileFailure, {
      paymentId: f.paymentId,
      generation: generation - 1,
    });
    for (let i = 0; i < 10; i++)
      await t.mutation(internal.billing.reconcileFailure, {
        paymentId: f.paymentId,
        generation,
      });
    const p = (await t.run((ctx) => ctx.db.get(f.paymentId)))!;
    expect(p.reconciliation).toMatchObject({
      attempts: 8,
      state: "needs_review",
    });
    expect(p.reconciliation.nextAttemptAt).toBeDefined();
    const cases = await t.run((ctx) =>
      ctx.db.query("financeReconciliationCases").collect(),
    );
    expect(
      cases.filter((c) => c.rowKind === "case" && c.kind === "payment"),
    ).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateState).toBe(
      "closing",
    );
    await complete(t, f.paymentId);
    expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
      gateState: "open",
      balance: 100000,
      lockedCredits: 100000,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(f.paymentId)))!.reconciliation
        .nextAttemptAt,
    ).toBeUndefined();
  });
  it("conserves two payments across two publishers with newest pending then newest released clawbacks", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "multi-a", 20000));
    const other = await t.run((ctx) =>
      prepareFinanceFixture(ctx, "multi-b", 20000),
    );
    const secondPayment = await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("checkoutIntents", other.paid.intentId)!;
      await ctx.db.patch(id, {
        organizationId: f.consumer,
        stripeCustomerId: f.paid.customerId,
      });
      return projectPaid(ctx, { ...other.paid, customerId: f.paid.customerId });
    });
    const secondPublisher = {
      ...f,
      publisher: other.publisher,
      project: other.project,
      version: other.version,
      specDigest: other.specDigest,
    };
    for (const [i, day] of [0, 1, 9, 10, 11, 12].entries()) {
      vi.setSystemTime(NOW + day * 86400000);
      await spend(t, i % 2 ? secondPublisher : f, i + 1);
      if (i === 2) {
        const earnings = await t.run((ctx) =>
          ctx.db.query("publisherEarnings").collect(),
        );
        for (const e of earnings)
          await t.run((ctx) => releaseEarning(ctx, e._id));
      }
    }
    const ordered = (
      await t.run((ctx) => ctx.db.query("publisherEarnings").collect())
    ).sort((a, b) => a.day.localeCompare(b.day));
    expect(ordered).toHaveLength(6);
    expect(ordered.map((e) => e.state)).toEqual([
      "released",
      "released",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    async function check(expected: number[], targetA: number, targetB: number) {
      const rows = await t.run((ctx) =>
        Promise.all(ordered.map((e) => ctx.db.get(e._id))),
      );
      expect(rows.map((e) => e!.clawedBackGrossCredits)).toEqual(expected);
      expect(
        (await t.run((ctx) => assertWallet(ctx, f.walletId))).balance,
      ).toBe(80000 - Math.min(80000, targetB));
      expect(
        rows
          .filter((e) => e!.paymentId === f.paymentId)
          .reduce((n, e) => n + e!.clawedBackGrossCredits, 0),
      ).toBe(targetA);
      expect(
        rows
          .filter((e) => e!.paymentId === secondPayment)
          .reduce((n, e) => n + e!.clawedBackGrossCredits, 0),
      ).toBe(Math.max(0, targetB - 80000));
      await auditPublisher(t);
    }
    await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_newest",
      amountCents: 306,
      status: "pending",
    });
    await complete(t, f.paymentId);
    await check([0, 0, 0, 10000, 20000, 0], 30000, 0);
    await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_more",
      amountCents: 612,
      status: "pending",
    });
    await complete(t, f.paymentId);
    await check([10000, 20000, 20000, 20000, 20000, 0], 90000, 0);
    await adjust(t, secondPayment, {
      kind: "refund",
      sourceRef: "re_second",
      amountCents: 1020,
      status: "succeeded",
    });
    await complete(t, secondPayment);
    await check([10000, 20000, 20000, 20000, 20000, 20000], 90000, 100000);
    await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_more",
      amountCents: 612,
      status: "failed",
    });
    await complete(t, f.paymentId);
    await check([0, 0, 0, 10000, 20000, 20000], 30000, 100000);
  });
});
describe("provider receipts", () => {
  it("verifies exact signed bytes, separates destinations, dedupes and fences expired leases", async () => {
    const t = harness();
    const body = JSON.stringify({
      id: "evt_one",
      type: "checkout.session.completed",
      created: Math.floor(NOW / 1000),
      livemode: false,
      data: { object: { id: "cs_fixture" } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: "fixture-signing-secret",
      timestamp: Math.floor(NOW / 1000),
    });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await t.fetch("/stripe-webhook", {
            method: "POST",
            body,
            headers: { "stripe-signature": signature },
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await t.fetch("/stripe-webhook", {
          method: "POST",
          body: body + " ",
          headers: { "stripe-signature": signature },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.fetch("/stripe-connect-webhook", {
          method: "POST",
          body,
          headers: { "stripe-signature": signature },
        })
      ).status,
    ).toBe(400);
    const receipt = (
      await t.run((ctx) => ctx.db.query("webhookReceipts").collect())
    )[0];
    expect(receipt.deliveries).toBe(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [patch, expected] of [
      [{ pending_webhooks: 0, request: { id: "req_new" } }, 200],
      [{ type: "checkout.session.expired" }, 503],
    ] as const) {
      const redelivery = JSON.stringify({ ...JSON.parse(body), ...patch });
      const sig = Stripe.webhooks.generateTestHeaderString({
        payload: redelivery,
        secret: "fixture-signing-secret",
        timestamp: Math.floor(NOW / 1000),
      });
      expect(
        (
          await t.fetch("/stripe-webhook", {
            method: "POST",
            body: redelivery,
            headers: { "stripe-signature": sig },
          })
        ).status,
      ).toBe(expected);
    }
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))!.deliveries).toBe(3);

    const first = (await t.mutation(internal.stripeEvents.claim, {
      id: receipt._id,
    }))!;
    vi.setSystemTime(NOW + 300001);
    const second = (await t.mutation(internal.stripeEvents.claim, {
      id: receipt._id,
    }))!;
    await expect(
      t.mutation(internal.stripeEvents.complete, {
        id: receipt._id,
        token: first.leaseToken!,
        json: JSON.stringify({ kind: "ignored" }),
      }),
    ).rejects.toThrow("Stale");
    await t.mutation(internal.stripeEvents.complete, {
      id: receipt._id,
      token: second.leaseToken!,
      json: JSON.stringify({ kind: "ignored" }),
    });
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))!.state).toBe(
      "complete",
    );
  });
  it("quarantines live events without granting", async () => {
    const t = harness();
    const body = JSON.stringify({
      id: "evt_live",
      type: "checkout.session.completed",
      created: Math.floor(NOW / 1000),
      livemode: true,
      data: { object: { id: "cs_live" } },
    });
    const sig = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: "fixture-signing-secret",
      timestamp: Math.floor(NOW / 1000),
    });
    expect(
      (
        await t.fetch("/stripe-webhook", {
          method: "POST",
          body,
          headers: { "stripe-signature": sig },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.run((ctx) =>
          ctx.db.query("financeReconciliationCases").collect(),
        )
      ).length,
    ).toBe(2);
    expect(
      await t.run((ctx) => ctx.db.query("payments").collect()),
    ).toHaveLength(0);
  });
});
describe("publisher transfer recovery", () => {
  async function ready(t: Harness) {
    const f = await t.run((ctx) => financeFixture(ctx));
    await t.run((ctx) =>
      appendPublisherEntry(ctx, {
        publisherOrganizationId: f.publisher,
        refId: "fixture-earned",
        kind: "release",
        availableDeltaAtoms: 2000000001,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
      }),
    );
    const id = await t.run(async (ctx) =>
      prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
    );
    return { f, id };
  }
  it("keeps sub-cent carry, definitive failure releases once, retry gets new identity", async () => {
    const t = harness(),
      { f, id } = await ready(t),
      claimed = (await t.run((ctx) => claimTransfer(ctx, id)))!;
    expect(claimed.amountCents).toBe(2000);
    await t.run((ctx) => transferFailure(ctx, id, claimed.leaseToken!, true));
    await t.run((ctx) => transferFailure(ctx, id, claimed.leaseToken!, true));
    const next = await t.run(async (ctx) =>
      prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
    );
    expect(next).not.toBe(id);
    expect((await t.run((ctx) => ctx.db.get(next)))!.idempotencyKey).not.toBe(
      claimed.idempotencyKey,
    );
    const b = (
      await t.run((ctx) => ctx.db.query("publisherBalances").collect())
    )[0];
    expect(b.availableAtoms).toBe(1);
    expect(b.allocatedAtoms).toBe(2000000000);
  });
  it("unknown outcome and exhausted scan retain allocation; verified reversal applies cumulative delta only", async () => {
    const t = harness(),
      { id } = await ready(t);
    let c = (await t.run((ctx) => claimTransfer(ctx, id)))!;
    await t.run((ctx) => transferFailure(ctx, id, c.leaseToken!, false));
    vi.setSystemTime(NOW + 86400000);
    c = (await t.run((ctx) => claimTransfer(ctx, id)))!;
    await t.run((ctx) =>
      transferScan(ctx, id, c.leaseToken!, undefined, [], true),
    );
    expect((await t.run((ctx) => ctx.db.get(id)))!.dispatchState).toBe(
      "needs_review",
    );
    expect(
      (await t.run((ctx) => ctx.db.query("publisherBalances").collect()))[0]
        .allocatedAtoms,
    ).toBe(2000000000);
    const fact = {
      id: "tr_late",
      amount: c.amountCents,
      currency: "usd",
      destination: c.destination,
      livemode: false,
      platformAccountId: PLATFORM,
      nonce: c.operationNonce,
      fingerprint: c.requestFingerprint,
      reversedCents: 500,
    };
    await t.run((ctx) => projectTransfer(ctx, id, fact));
    await t.run((ctx) => projectTransfer(ctx, id, fact));
    await t.run((ctx) =>
      projectTransfer(ctx, id, { ...fact, reversedCents: 100 }),
    );
    const b = (
      await t.run((ctx) => ctx.db.query("publisherBalances").collect())
    )[0];
    expect(b.paidAtoms).toBe(1500000000);
    expect(b.availableAtoms).toBe(500000001);
    expect(b.allocatedAtoms).toBe(0);
    await expect(
      t.run((ctx) =>
        projectTransfer(ctx, id, { ...fact, destination: "acct_wrong" }),
      ),
    ).rejects.toThrow("mismatch");
  });
  it("paginates Accounts v2 beyond 100 and rejects foreign cursor origins", async () => {
    const list = vi.fn().mockResolvedValue({
      data: Array.from({ length: 100 }, (_, i) => ({ id: `acct_${i}` })),
      next_page_url: "https://api.stripe.com/v2/core/accounts?page=2",
    });
    const rawRequest = vi
      .fn()
      .mockResolvedValue({ data: [{ id: "acct_100" }], next_page_url: null });
    const fake = {
      v2: { core: { accounts: { list } } },
      rawRequest,
    } as unknown as Stripe;
    const first = await accountPage(fake),
      second = await accountPage(fake, first.next);
    expect(first.ids.length + second.ids.length).toBe(101);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/v2/core/accounts?page=2");
    await expect(
      accountPage(fake, "https://evil.example/v2/core/accounts"),
    ).rejects.toThrow(/./);
    expect(ACCOUNT_REPLAY_MS).toBeGreaterThan(23 * 3600000);
  });
});

describe("conservation and transaction bounds", () => {
  it("reference model interleaves settled calls, overlapping source facts, restoration, and risk release", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "model", 1000));
    let rng = 436438,
      spent = 0;
    const random = () => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng;
    };
    let refundActive = false,
      withdrawn = false,
      reinstated = false;
    for (let step = 0; step < 32; step++) {
      const choice = random() % 4;
      if (choice === 0) {
        const w = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
        if (w.balance >= 1000) {
          await spend(t, f, w.settledThroughEdgeSequence + 1);
          spent += 1000;
        }
      } else if (choice === 1) {
        refundActive = !refundActive;
        await adjust(t, f.paymentId, {
          kind: "refund",
          sourceRef: "re_model",
          amountCents: 306,
          status: refundActive ? "pending" : "failed",
        });
        await complete(t, f.paymentId);
      } else {
        if (choice === 2) withdrawn = true;
        else reinstated = true;
        await adjust(t, f.paymentId, {
          kind: "dispute",
          sourceRef: "dp_model",
          amountCents: 510,
          status: reinstated ? "won" : "open",
          movement: choice === 2 ? "withdrawal" : "reinstatement",
        });
        await complete(t, f.paymentId);
      }
      const target =
        (refundActive ? 30000 : 0) + (withdrawn && !reinstated ? 50000 : 0);
      expect(
        (await t.run((ctx) => assertWallet(ctx, f.walletId))).balance,
      ).toBe(Math.max(0, 100000 - spent - target));
      const earnings = await t.run((ctx) =>
        ctx.db.query("publisherEarnings").collect(),
      );
      expect(earnings.reduce((n, e) => n + e.clawedBackGrossCredits, 0)).toBe(
        Math.max(0, target - (100000 - spent)),
      );
      await auditPublisher(t);
    }
    vi.setSystemTime(NOW + 9 * 86400000);
    const earnings = await t.run((ctx) =>
      ctx.db.query("publisherEarnings").collect(),
    );
    for (const e of earnings) await t.run((ctx) => releaseEarning(ctx, e._id));
    await auditPublisher(t);
  });
  it("blocks transfers while a restoration generation temporarily returns released funds", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "blocked", 100000));
    await spend(t, f);
    vi.setSystemTime(NOW + 9 * 86400000);
    const e = (
      await t.run((ctx) => ctx.db.query("publisherEarnings").collect())
    )[0];
    await t.run((ctx) => releaseEarning(ctx, e._id));
    await t.run((ctx) =>
      appendPublisherEntry(ctx, {
        publisherOrganizationId: f.publisher,
        refId: "other-release",
        kind: "release",
        availableDeltaAtoms: 1000000000,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
      }),
    );
    await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_block",
      amountCents: 1020,
      status: "pending",
    });
    await complete(t, f.paymentId);
    const generation = await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_block",
      amountCents: 1020,
      status: "failed",
    });
    await t.run((ctx) => drain(ctx, f.walletId));
    await t.run((ctx) => reconcilePaymentPage(ctx, f.paymentId, generation));
    await expect(
      t.run(async (ctx) =>
        prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
      ),
    ).rejects.toThrow("reconciliation is pending");
    await complete(t, f.paymentId);
    expect(
      await t.run(async (ctx) =>
        prepareTransfer(ctx, (await ctx.db.get(f.publisher))!),
      ),
    ).toBeTruthy();
  });
  it("pages through 257 earning buckets with bounded document reads and writes", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "large", 257));
    await spend(t, f);
    await t.run(async (ctx) => {
      const original = (await ctx.db.query("publisherEarnings").collect())[0];
      await ctx.db.delete(original._id);
      const rollups = await ctx.db.query("usageRollups").collect();
      for (const r of rollups)
        if (
          r.kind === "daily" &&
          r.scope === "publisher" &&
          r.dimension !== "endpoint"
        )
          await ctx.db.patch(r._id, { pendingRiskAtoms: 0 });
      for (let i = 0; i < 257; i++) {
        const day = new Date(Date.UTC(1990, 0, 1) + i * 86400000)
          .toISOString()
          .slice(0, 10);
        const { _id, _creationTime, ...base } = original;
        await ctx.db.insert("publisherEarnings", {
          ...base,
          day,
          grossCredits: 1,
          netAtoms: 9500,
          platformFeeAtoms: 500,
          availableAt: NOW + 86400000,
        });
        for (const dimension of ["total", "project"] as const)
          await ctx.db.insert("usageRollups", {
            kind: "daily",
            scope: "publisher",
            scopeId: f.publisher,
            dimension,
            dimensionKey: dimension === "total" ? "all" : f.project,
            shard: dimension === "total" ? original.shard : original.shard % 16,
            day,
            calls: 0,
            grossCredits: 0,
            netAtoms: 0,
            pendingRiskAtoms: 9500,
            reversedAtoms: 0,
            failedAtoms: 0,
            success: 0,
            errors4xx: 0,
            errors5xx: 0,
            latencyHistogram: Array<number>(12).fill(0),
            updatedAt: NOW,
          });
      }
    });
    const gen = await adjust(t, f.paymentId, {
      kind: "refund",
      sourceRef: "re_large",
      amountCents: 1020,
      status: "succeeded",
    });
    await t.run((ctx) => drain(ctx, f.walletId));
    let pages = 0;
    const peak = {
      writes: 0,
      argumentBytes: 0,
      readBytes: 0,
      documentWriteBytes: 0,
    };
    for (; pages < 100; pages++) {
      const measured = await t.run((ctx) =>
        measure(ctx, (c) => reconcilePaymentPage(c, f.paymentId, gen)),
      );
      for (const key of Object.keys(peak) as (keyof typeof peak)[])
        peak[key] = Math.max(peak[key], measured[key]);
      if (measured.result === "done") break;
    }
    expect(pages).toBeGreaterThan(32);
    expect(pages).toBeLessThan(100);
    expect(peak.writes).toBeLessThan(150);
    expect(peak.argumentBytes).toBeLessThan(200000);
    expect(peak.readBytes).toBeLessThan(1000000);
    expect(peak.documentWriteBytes).toBeLessThan(1000000);
    const p = (await t.run((ctx) => ctx.db.get(f.paymentId)))!;
    expect(p.reconciliation.state).toBe("complete");
    expect(p.reconciliation.publisherTargetCredits).toBe(257);
    await auditPublisher(t);
    await t.run((ctx) => assertWallet(ctx, f.walletId));
    console.log("PR4 reconciliation measured JSON budgets", peak);
  }, 120000);
});

describe("canonical Stripe processor with network fakes", () => {
  async function fixture(
    t: Harness,
    change?: { target: string; field: string; value: unknown },
  ) {
    const f = await t.run((ctx) => prepareFinanceFixture(ctx, "provider"));
    const responses: Record<string, Record<string, unknown>> = {
      "/v1/account": { id: PLATFORM, default_currency: "usd" },
      "/v1/balance": { livemode: false },
      "/v1/checkout/sessions/cs_provider": {
        id: "cs_provider",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        livemode: false,
        metadata: { checkoutIntentId: f.paid.intentId },
        payment_intent: "pi_provider",
        customer: "cus_provider",
        amount_total: 1020,
        currency: "usd",
      },
      "/v1/checkout/sessions/cs_provider/line_items": {
        data: f.paid.lines.map((l) => ({
          price: { id: l.priceId },
          quantity: l.quantity,
          amount_total: l.amountCents,
        })),
        has_more: false,
      },
      "/v1/payment_intents/pi_provider": {
        id: "pi_provider",
        latest_charge: "ch_provider",
        customer: "cus_provider",
        status: "succeeded",
        amount_received: 1020,
        currency: "usd",
        livemode: false,
        metadata: { checkoutIntentId: f.paid.intentId },
      },
      "/v1/charges/ch_provider": {
        id: "ch_provider",
        payment_intent: "pi_provider",
        customer: "cus_provider",
        paid: true,
        captured: true,
        amount: 1020,
        currency: "usd",
        livemode: false,
        balance_transaction: { fee: 40, currency: "usd" },
      },
    };
    if (change) responses[change.target][change.field] = change.value;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Request(input, init).headers.get("stripe-version")).toBe(
          "2026-06-24.dahlia",
        );
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const value = responses[url.pathname];
        if (!value)
          throw new Error(`Unexpected fixture request ${url.pathname}`);
        return Response.json(value);
      }),
    );
    const body = JSON.stringify({
      id: "evt_provider",
      type: "checkout.session.completed",
      created: Math.floor(NOW / 1000),
      livemode: false,
      data: { object: { id: "cs_provider" } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: "fixture-signing-secret",
      timestamp: Math.floor(NOW / 1000),
    });
    expect(
      (
        await t.fetch("/stripe-webhook", {
          method: "POST",
          body,
          headers: { "stripe-signature": signature },
        })
      ).status,
    ).toBe(200);
    const receipt = (
      await t.run((ctx) => ctx.db.query("webhookReceipts").collect())
    )[0];
    await t.action(internal.stripeEvents.processReceipt, { id: receipt._id });
    return { f, receipt, responses };
  }
  it("projects signed Checkout only after canonical verification and atomically completes receipt", async () => {
    const t = harness(),
      { f, receipt } = await fixture(t);
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))!.state).toBe(
      "complete",
    );
    const p = (await t.run((ctx) => ctx.db.query("payments").collect()))[0];
    expect(p.processingFeeVarianceCents).toBe(20);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      100000,
    );
  });
  it.each([
    ["/v1/account", "id", "acct_foreign"],
    ["/v1/balance", "livemode", true],
    ["/v1/checkout/sessions/cs_provider", "customer", "cus_foreign"],
    ["/v1/checkout/sessions/cs_provider", "currency", "eur"],
    ["/v1/checkout/sessions/cs_provider", "amount_total", 999],
    ["/v1/payment_intents/pi_provider", "status", "processing"],
    [
      "/v1/payment_intents/pi_provider",
      "metadata",
      { checkoutIntentId: "foreign" },
    ],
    ["/v1/charges/ch_provider", "livemode", true],
    [
      "/v1/checkout/sessions/cs_provider/line_items",
      "data",
      [{ price: { id: "price_provider" }, quantity: 2, amount_total: 1020 }],
    ],
    ["/v1/checkout/sessions/cs_provider/line_items", "has_more", true],
  ])("rejects mismatched canonical %s %s", async (target, field, value) => {
    const t = harness(),
      { f, receipt } = await fixture(t, { target, field, value });
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))!.state).toBe(
      "retry",
    );
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      0,
    );
  });
  it("recovers dispute movements from every event and freezes only when exposure changes", async () => {
    const t = harness(),
      { f, responses } = await fixture(t);
    const p = (await t.run((ctx) => ctx.db.query("payments").collect()))[0];
    const tx = (amount: number) => ({
      id: `txn_${amount}`,
      amount,
      net: amount - 1500,
      currency: "usd",
    });
    let generation = 0;
    let freezes = 0;
    const gates: number[] = [];
    for (const [i, [eventType, status, transactions, expectedGeneration]] of [
      ["charge.dispute.created", "needs_response", [], 0],
      ["charge.dispute.funds_withdrawn", "needs_response", [tx(-1020)], 1],
      ["charge.dispute.updated", "under_review", [tx(-1020)], 1],
      ["charge.dispute.closed", "lost", [tx(-1020)], 1],
      // Reinstatement receipt never arrives: a later updated receipt carries both movements.
      ["charge.dispute.updated", "won", [tx(-1020), tx(1020)], 2],
      // Delayed withdrawal receipt must not reapply the now-reinstated exposure.
      ["charge.dispute.funds_withdrawn", "won", [tx(-1020), tx(1020)], 2],
    ].entries()) {
      responses["/v1/disputes/dp_lifecycle"] = {
        id: "dp_lifecycle",
        charge: "ch_provider",
        amount: 1020,
        currency: "usd",
        livemode: false,
        status,
        balance_transactions: transactions,
      };
      const receipt = await t.mutation(internal.stripeEvents.receive, {
        json: JSON.stringify({
          eventId: `evt_lifecycle_${i}`,
          eventType,
          objectId: "dp_lifecycle",
          account: PLATFORM,
          sourceTimestamp: NOW,
          payloadHash: `hash_${i}`,
          destination: "platform",
          foreign: false,
        }),
      });
      await t.action(internal.stripeEvents.processReceipt, { id: receipt });
      expect((await t.run((ctx) => ctx.db.get(receipt)))!.state).toBe(
        "complete",
      );
      const changed = (await t.run((ctx) => ctx.db.get(p._id)))!;
      expect(changed.reconciliation.generation).toBe(expectedGeneration);
      if (generation !== changed.reconciliation.generation) freezes++;
      generation = changed.reconciliation.generation;
      await complete(t, p._id);
      gates.push((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateRevision);
    }
    expect(freezes).toBe(2);
    expect(gates[2]).toBe(gates[1]);
    expect(gates[3]).toBe(gates[1]);
    expect(gates[5]).toBe(gates[4]);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      100000,
    );
    // A later closed event alone also recovers a missing funds_withdrawn receipt.
    responses["/v1/disputes/dp_missing"] = {
      id: "dp_missing",
      charge: "ch_provider",
      amount: 510,
      currency: "usd",
      livemode: false,
      status: "lost",
      balance_transactions: [tx(-510)],
    };
    const receipt = await t.mutation(internal.stripeEvents.receive, {
      json: JSON.stringify({
        eventId: "evt_missing",
        eventType: "charge.dispute.closed",
        objectId: "dp_missing",
        account: PLATFORM,
        sourceTimestamp: NOW,
        payloadHash: "missing",
        destination: "platform",
        foreign: false,
      }),
    });
    await t.action(internal.stripeEvents.processReceipt, { id: receipt });
    await complete(t, p._id);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      50000,
    );
  });
  it("retries a nine-minute outage and escalates only after more than three days", async () => {
    const t = harness(),
      { receipt, responses } = await fixture(t, {
        target: "/v1/account",
        field: "id",
        value: "acct_outage",
      });
    let row = (await t.run((ctx) => ctx.db.get(receipt._id)))!;
    while (row.attempts < 10) {
      vi.setSystemTime(row.nextAttemptAt!);
      await t.action(internal.stripeEvents.processReceipt, { id: receipt._id });
      row = (await t.run((ctx) => ctx.db.get(receipt._id)))!;
    }
    expect(row.state).toBe("retry");
    expect(Date.now() - NOW).toBeGreaterThan(9 * 60_000);
    responses["/v1/account"].id = PLATFORM;
    vi.setSystemTime(row.nextAttemptAt!);
    await t.action(internal.stripeEvents.processReceipt, { id: receipt._id });
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))!.state).toBe(
      "complete",
    );
    const id = await t.mutation(internal.stripeEvents.receive, {
      json: JSON.stringify({
        eventId: "evt_exhaust",
        eventType: "charge.dispute.closed",
        objectId: "dp_outage",
        account: PLATFORM,
        sourceTimestamp: NOW,
        payloadHash: "exhaust",
        destination: "platform",
        foreign: false,
      }),
    });
    const started = Date.now();
    for (let i = 0; i < 84; i++) {
      const claimed = (await t.mutation(internal.stripeEvents.claim, { id }))!;
      await t.mutation(internal.stripeEvents.fail, {
        id,
        token: claimed.leaseToken!,
      });
      const failed = (await t.run((ctx) => ctx.db.get(id)))!;
      if (i < 83) {
        expect(failed.state).toBe("retry");
        expect(failed.nextAttemptAt! - Date.now()).toBeLessThanOrEqual(3600000);
        vi.setSystemTime(failed.nextAttemptAt!);
      } else {
        expect(failed.state).toBe("needs_review");
        expect(failed.nextAttemptAt).toBeUndefined();
      }
    }
    expect(Date.now() - started).toBeGreaterThan(3 * 86400000);
    expect(await t.mutation(internal.stripeEvents.claim, { id })).toBeNull();
    const cases = await t.run((ctx) =>
      ctx.db.query("financeReconciliationCases").collect(),
    );
    expect(
      cases.filter(
        (c) => c.rowKind === "case" && c.operationId === `receipt:${id}`,
      ),
    ).toHaveLength(1);
  });
  it("payout projections use revision fences and never touch publisher money", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx));
    const before = await t.run((ctx) =>
      ctx.db.query("publisherLedgerEntries").collect(),
    );
    async function receipt(name: string) {
      const id = await t.mutation(internal.stripeEvents.receive, {
        json: JSON.stringify({
          eventId: name,
          eventType: "payout.updated",
          objectId: "po_fixture",
          account: "acct_finance",
          sourceTimestamp: NOW,
          payloadHash: name,
          destination: "connect",
          foreign: false,
        }),
      });
      return (await t.mutation(internal.stripeEvents.claim, { id }))!;
    }
    const first = await receipt("evt_payout_1"),
      second = await receipt("evt_payout_2");
    const projection = {
      kind: "payout",
      id: "po_fixture",
      accountId: "acct_finance",
      amountCents: 1000,
      currency: "usd",
      status: "paid",
      expectedRevision: 0,
    };
    await t.mutation(internal.stripeEvents.complete, {
      id: first._id,
      token: first.leaseToken!,
      json: JSON.stringify(projection),
    });
    await expect(
      t.mutation(internal.stripeEvents.complete, {
        id: second._id,
        token: second.leaseToken!,
        json: JSON.stringify({ ...projection, status: "pending" }),
      }),
    ).rejects.toThrow("refetch");
    await t.mutation(internal.stripeEvents.complete, {
      id: second._id,
      token: second.leaseToken!,
      json: JSON.stringify({
        ...projection,
        expectedRevision: 1,
        status: "failed",
      }),
    });
    expect(
      await t.run((ctx) => ctx.db.query("publisherLedgerEntries").collect()),
    ).toEqual(before);
    expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.balance).toBe(
      100000,
    );
  });
  it("retains unresolved Connect PII and claims a verified account once", async () => {
    const t = harness(),
      f = await t.run((ctx) => financeFixture(ctx, "connect"));
    const op = {
      id: "op",
      kind: "account" as const,
      requestFingerprint: "fp",
      state: "processing" as const,
      leaseToken: "lease",
      leaseUntil: NOW + 1000,
      country: "US",
      contactEmail: "fixture@example.invalid",
      displayName: "Fixture",
      startedAt: NOW,
      platformAccountId: PLATFORM,
    };
    await t.run((ctx) =>
      ctx.db.patch(f.publisher, { connect: undefined, connectOperation: op }),
    );
    await t.mutation(internal.connect.failed, {
      id: f.publisher,
      token: "lease",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(f.publisher)))!.connectOperation!
        .contactEmail,
    ).toBe("fixture@example.invalid");
    const fact = {
      id: "acct_verified",
      livemode: false as const,
      closed: false,
      organizationId: f.publisher,
      operationId: "op",
      fingerprint: "fp",
      country: "US",
      status: "active" as const,
      requirements: [],
    };
    await t.run(async (ctx) =>
      commitAccount(ctx, (await ctx.db.get(f.publisher))!, fact),
    );
    const org = (await t.run((ctx) => ctx.db.get(f.publisher)))!;
    expect(org.connect!.accountId).toBe("acct_verified");
    expect(org.connectOperation!.contactEmail).toBeUndefined();
    await t.run((ctx) => ctx.db.patch(f.consumer, { connectOperation: op }));
    await expect(
      t.run(async (ctx) =>
        commitAccount(ctx, (await ctx.db.get(f.consumer))!, {
          ...fact,
          organizationId: f.consumer,
        }),
      ),
    ).rejects.toThrow("already belongs");
  });
});

describe("Checkout fee legal gate", () => {
  it("defaults off, snapshots the estimate when enabled, and requires an admin", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        ...organization("checkout-gate"),
        stripeCustomerId: "cus_gate",
      });
    });
    const admin = t.withIdentity({
      subject: "user_gate",
      org_id: "org_checkout-gate",
      org_role: "org:admin",
    });
    vi.stubEnv("NEXT_STRIPE_PRICE_PACK_10", "price_credits");
    vi.stubEnv("NEXT_CARD_FEE_ENABLED", "");
    vi.stubEnv("NEXT_STRIPE_FEE_PACK_10_CENTS", "42");
    vi.stubEnv("NEXT_STRIPE_FEE_PACK_10_PRICE", "price_fee");
    const disabled = await admin.mutation(
      internal.billing.prepareCheckoutIntent,
      { packId: "pack_10", customerId: "cus_gate" },
    );
    expect(disabled).toMatchObject({
      totalCents: 1000,
      processingFeeQuotedCents: 0,
      feePolicyVersion: "disabled-v1",
    });
    expect(disabled.feeLinePriceId).toBeUndefined();
    vi.stubEnv("NEXT_CARD_FEE_ENABLED", "true");
    const enabled = await admin.mutation(
      internal.billing.prepareCheckoutIntent,
      { packId: "pack_10", customerId: "cus_gate" },
    );
    expect(enabled).toMatchObject({
      totalCents: 1042,
      processingFeeQuotedCents: 42,
      feeLinePriceId: "price_fee",
      feePolicyVersion: "estimated-v1",
    });
    await expect(
      t
        .withIdentity({
          subject: "member_gate",
          org_id: "org_checkout-gate",
          org_role: "org:member",
        })
        .mutation(internal.billing.prepareCheckoutIntent, {
          packId: "pack_10",
          customerId: "cus_gate",
        }),
    ).rejects.toThrow("Org admin or owner role required");
    expect(fetch).not.toHaveBeenCalled();
  });
});
