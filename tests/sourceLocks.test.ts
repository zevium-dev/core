import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { harness, type Harness } from "./helpers";
import { moneyFixture, paidLot, eventFor, assertWallet } from "./moneyFixtures";
import { drain } from "./financeFixtures";
import { NOW, SECRET } from "./fixtures";
import { grantLot, allocate } from "../convex/money/lots";
import { beginDustMerge, moveDustPage } from "../convex/money/dust";
import {
  projectAdjustment,
  reconcilePaymentPage,
  reviewPayment,
  retryReviewedPayment,
} from "../convex/money/adjustments";
import { settleOne } from "../convex/money/settle";
import { internal, api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { walletPage } from "@zevium/shared/edge/replication";
const ring = { current: "k1", keys: { k1: SECRET } };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
  vi.stubEnv("NEXT_ADMISSION_KEYS", JSON.stringify(ring));
  vi.stubEnv("NEXT_SNAPSHOT_KEYS", JSON.stringify(ring));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function finish(t: Harness, paymentId: Id<"payments">) {
  for (let i = 0; i < 100; i++) {
    const p = (await t.run((ctx) => ctx.db.get(paymentId)))!;
    const result = await t.run((ctx) =>
      reconcilePaymentPage(ctx, paymentId, p.reconciliation.generation),
    );
    await t.run((ctx) => assertWallet(ctx, p.walletId));
    if (result === "done") return;
    if (result === "waiting") await t.run((ctx) => drain(ctx, p.walletId));
  }
  throw new Error("Review did not finish");
}
async function adjustment(
  t: Harness,
  paymentId: Id<"payments">,
  status: "pending" | "failed",
) {
  return t.run(async (ctx) => {
    const p = (await ctx.db.get(paymentId))!;
    await projectAdjustment(ctx, paymentId, p.revision, {
      kind: "refund",
      sourceRef: `refund:${paymentId}`,
      amountCents: 1,
      status,
    });
    return (await ctx.db.get(paymentId))!.reconciliation.generation;
  });
}
async function review(t: Harness, paymentId: Id<"payments">) {
  await t.run(async (ctx) =>
    reviewPayment(ctx, (await ctx.db.get(paymentId))!, 8),
  );
}
it("quarantines a merged origin, preserves unlocked dust, and restores access without minting", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "mixed-lock", [], 100));
  const a = await t.run((ctx) => paidLot(ctx, f.walletId, "a", 200));
  vi.advanceTimersByTime(1);
  const b = await t.run((ctx) => paidLot(ctx, f.walletId, "b", 300));
  const merge = (await t.run((ctx) => beginDustMerge(ctx, a.lot._id)))!;
  await t.run((ctx) => drain(ctx, f.walletId));
  await t.run((ctx) => moveDustPage(ctx, a.lot._id, merge.merge!.generation));
  await t.run((ctx) =>
    grantLot(ctx, {
      walletId: f.walletId,
      sourceKind: "promo",
      sourceRef: "promo",
      credits: 100,
    }),
  );
  const generation = await adjustment(t, a.lot.paymentId!, "pending");
  await review(t, a.lot.paymentId!);
  expect(
    await t.run((ctx) =>
      reconcilePaymentPage(ctx, a.lot.paymentId!, generation),
    ),
  ).toBe("waiting");
  await finish(t, a.lot.paymentId!);
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 600,
    lockedCredits: 200,
    gateState: "open",
  });
  const wallet = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  const projection = await t.query(internal.edgeSnapshots.read, {
    kind: "wallet",
    scope: wallet.owner.clerkOrgId,
    now: Date.now(),
  });
  const cp = walletPage.parse(projection.payload).checkpoint;
  expect(cp.balance).toBe(400);
  expect(cp.sources.some((s) => s.paymentId === a.lot.paymentId)).toBe(false);
  expect(
    cp.sources.find((s) => s.paymentId === b.lot.paymentId)?.remainingCredits,
  ).toBe(300);
  const event = await t.run((ctx) => eventFor(ctx, f));
  expect((await t.run((ctx) => settleOne(ctx, event))).status).toBe("applied");
  expect((await t.run((ctx) => settleOne(ctx, event))).status).toBe(
    "already_applied",
  );
  vi.advanceTimersByTime(1);
  const c = await t.run((ctx) => paidLot(ctx, f.walletId, "c", 1000));
  const next = (await t.run((ctx) => beginDustMerge(ctx, b.lot._id)))!;
  await t.run((ctx) => drain(ctx, f.walletId));
  await t.run((ctx) => moveDustPage(ctx, b.lot._id, next.merge!.generation));
  expect(await t.run((ctx) => ctx.db.get(b.lot._id))).toMatchObject({
    remainingCredits: 200,
    movedOutCredits: 300,
  });
  expect(await t.run((ctx) => ctx.db.get(c.lot._id))).toMatchObject({
    remainingCredits: 1300,
  });
  await adjustment(t, a.lot.paymentId!, "failed");
  expect(
    await t.run((ctx) =>
      reconcilePaymentPage(ctx, a.lot.paymentId!, generation),
    ),
  ).toBe("done");
  await finish(t, a.lot.paymentId!);
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 1500,
    lockedCredits: 0,
    gateState: "open",
  });
  await t.run((ctx) => assertWallet(ctx, f.walletId));
});
it("operator retry fences old pages and restores partial effects while sources stay locked", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "retry-lock", [], 100));
  const a = await t.run((ctx) => paidLot(ctx, f.walletId, "retry-a", 500));
  const generation = await adjustment(t, a.lot.paymentId!, "pending");
  await t.run((ctx) => drain(ctx, f.walletId));
  // restore publisher, restore wallet, target, wallet debit.
  for (let i = 0; i < 4; i++)
    await t.run((ctx) =>
      reconcilePaymentPage(ctx, a.lot.paymentId!, generation),
    );
  expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.balance).toBe(400);
  await review(t, a.lot.paymentId!);
  await finish(t, a.lot.paymentId!);
  vi.stubEnv("ADMIN_USER_IDS", "lock-operator");
  const operator = t.withIdentity({ subject: "lock-operator" });
  await operator.mutation(api.operators.retryPayment, {
    paymentId: a.lot.paymentId!,
    generation,
    reason: "Verified canonical refund facts",
  });
  const p = (await t.run((ctx) => ctx.db.get(a.lot.paymentId!)))!;
  expect(p.reconciliation.generation).toBe(generation + 1);
  expect(p.reconciliation.closeId).not.toBe(`payment:${p._id}:${generation}`);
  expect(
    await t.run((ctx) => reconcilePaymentPage(ctx, p._id, generation)),
  ).toBe("done");
  await t.run((ctx) => drain(ctx, f.walletId));
  await t.run((ctx) => reconcilePaymentPage(ctx, p._id, generation + 1));
  await t.run((ctx) => reconcilePaymentPage(ctx, p._id, generation + 1));
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 500,
    lockedCredits: 500,
    gateState: "closing",
  });
  await expect(t.run((ctx) => allocate(ctx, f.walletId, 1))).rejects.toThrow(
    "Insufficient credits",
  );
  await finish(t, p._id);
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 400,
    lockedCredits: 0,
    gateState: "open",
  });
});
it("matches a source reference model across repeated locks, spends, refunds and replays", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "lock-model", [], 100));
  const origins = [];
  for (let i = 0; i < 8; i++) {
    vi.advanceTimersByTime(1);
    origins.push(
      await t.run((ctx) => paidLot(ctx, f.walletId, `model:${i}`, 1000)),
    );
  }
  const model = origins.map((o) => ({
    id: o.lot.paymentId!,
    left: 1000,
    locked: false,
  }));
  for (let i = 0; i < model.length; i++) {
    const source = model[i];
    await adjustment(t, source.id, "pending");
    await review(t, source.id);
    await finish(t, source.id);
    source.locked = true;
    const w = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
    const available = model.filter((m) => !m.locked && m.left > 0);
    if (available.length) {
      const event = await t.run((ctx) => eventFor(ctx, f));
      expect(event.fundingSlices[0].paymentId).toBe(available[0].id);
      expect((await t.run((ctx) => settleOne(ctx, event))).status).toBe(
        "applied",
      );
      expect((await t.run((ctx) => settleOne(ctx, event))).status).toBe(
        "already_applied",
      );
      available[0].left -= 100;
    } else
      await expect(
        t.run((ctx) => allocate(ctx, f.walletId, 0)),
      ).rejects.toThrow("Insufficient credits");
    expect(w.lockedCredits).toBe(
      model.filter((m) => m.locked).reduce((n, m) => n + m.left, 0),
    );
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  }
  for (const source of model) {
    const p = (await t.run((ctx) => ctx.db.get(source.id)))!;
    await t.run((ctx) => retryReviewedPayment(ctx, p));
    await finish(t, source.id);
    source.left -= 100;
    source.locked = false;
    const w = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
    expect(w.balance).toBe(model.reduce((n, m) => n + m.left, 0));
    expect(w.lockedCredits).toBe(
      model.filter((m) => m.locked).reduce((n, m) => n + m.left, 0),
    );
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  }
});
it("pages source quarantine across repeated moves and resumes interrupted work without double-locking", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "paged-lock", [], 100));
  const original = await t.run((ctx) =>
    paidLot(ctx, f.walletId, "paged-origin", 200),
  );
  let container = original.lot._id;
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(1);
    const next = await t.run((ctx) =>
      paidLot(ctx, f.walletId, `paged-${i}`, 100),
    );
    const merge = (await t.run((ctx) =>
      beginDustMerge(ctx, container, 10000),
    ))!;
    await t.run((ctx) => drain(ctx, f.walletId));
    await t.run((ctx) => moveDustPage(ctx, container, merge.merge!.generation));
    container = next.lot._id;
  }
  const generation = await adjustment(t, original.lot.paymentId!, "pending");
  await review(t, original.lot.paymentId!);
  await t.run((ctx) => drain(ctx, f.walletId));
  expect(
    await t.run((ctx) =>
      reconcilePaymentPage(ctx, original.lot.paymentId!, generation),
    ),
  ).toBe("more");
  expect((await t.run((ctx) => ctx.db.get(f.walletId)))!.gateState).toBe(
    "closing",
  );
  await expect(
    t.run(async (ctx) =>
      retryReviewedPayment(ctx, (await ctx.db.get(original.lot.paymentId!))!),
    ),
  ).rejects.toThrow("quarantine must finish");
  await finish(t, original.lot.paymentId!);
  const before = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  expect(before).toMatchObject({
    lockedCredits: 200,
    balance: 1200,
    gateState: "open",
  });
  expect(
    await t.run((ctx) =>
      reconcilePaymentPage(ctx, original.lot.paymentId!, generation),
    ),
  ).toBe("done");
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toEqual(before);
  await adjustment(t, original.lot.paymentId!, "failed");
  await finish(t, original.lot.paymentId!);
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    lockedCredits: 0,
    balance: 1200,
    gateState: "open",
  });
});
it("unrecoverable exposure finishes review quarantine and leaves unrelated funds open", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "unrecoverable-lock", [], 100));
  const original = await t.run((ctx) =>
    paidLot(ctx, f.walletId, "unrecoverable-origin", 100),
  );
  // A legitimate admin debit has no publisher earning to claw back for this payment.
  const { beginAdminDecrease, applyAdminDecrease } =
    await import("../convex/money/sourceAdjustments");
  const close = await t.run((ctx) =>
    beginAdminDecrease(ctx, f.walletId, 100, "admin-consumed"),
  );
  await t.run((ctx) => drain(ctx, f.walletId));
  await t.run((ctx) =>
    applyAdminDecrease(ctx, f.walletId, close.close!.id, 100),
  );
  await t.run((ctx) => paidLot(ctx, f.walletId, "unrecoverable-other", 100));
  await adjustment(t, original.lot.paymentId!, "pending");
  await finish(t, original.lot.paymentId!);
  expect(
    (await t.run((ctx) => ctx.db.get(original.lot.paymentId!)))!.reconciliation,
  ).toMatchObject({ state: "needs_review", reviewLock: { complete: true } });
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 100,
    lockedCredits: 0,
    gateState: "open",
  });
  expect(
    (await t.run((ctx) => allocate(ctx, f.walletId, 100)))[0].paymentId,
  ).not.toBe(original.lot.paymentId);
});
it("never starts a dust freeze for a container holding only locked balances", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "locked-dust", [], 100));
  const a = await t.run((ctx) =>
    paidLot(ctx, f.walletId, "locked-dust-a", 200),
  );
  vi.advanceTimersByTime(1);
  await t.run((ctx) => paidLot(ctx, f.walletId, "locked-dust-b", 300));
  await adjustment(t, a.lot.paymentId!, "pending");
  await review(t, a.lot.paymentId!);
  await finish(t, a.lot.paymentId!);
  const before = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  expect(before).toMatchObject({ lockedCredits: 200, gateState: "open" });
  expect(await t.run((ctx) => beginDustMerge(ctx, a.lot._id))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toEqual(before);
});

it("skips 33 older locked-only containers before bounded FIFO allocation and admin decrease", async () => {
  const t = harness();
  const f = await t.run((ctx) => moneyFixture(ctx, "locked-capacity", [], 100));
  for (let i = 0; i < 33; i++) {
    const paid = await t.run((ctx) =>
      paidLot(ctx, f.walletId, `locked-capacity:${i}`, 100),
    );
    await adjustment(t, paid.lot.paymentId!, "pending");
    await review(t, paid.lot.paymentId!);
    await finish(t, paid.lot.paymentId!);
    vi.advanceTimersByTime(1);
  }
  const unlocked = await t.run((ctx) =>
    paidLot(ctx, f.walletId, "unlocked-capacity", 200),
  );
  const { measure } = await import("./measureDb");
  const allocation = await t.run((ctx) =>
    measure(ctx, (measured) => allocate(measured, f.walletId, 100)),
  );
  expect(allocation.result).toMatchObject([
    { lotId: unlocked.lot._id, credits: 100 },
  ]);
  expect(allocation.readRowsByIndex.by_spend).toBe(1);
  expect(allocation.readRowsByIndex.by_lot_spend).toBe(1);
  const wallet = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  const snapshot = walletPage.parse(
    (
      await t.query(internal.edgeSnapshots.read, {
        kind: "wallet",
        scope: wallet.owner.clerkOrgId,
        now: Date.now(),
      })
    ).payload,
  ).checkpoint;
  expect(snapshot.balance).toBe(200);
  expect(snapshot.sources).toMatchObject([
    { lotId: unlocked.lot._id, remainingCredits: 200 },
  ]);
  expect(snapshot.sources).toHaveLength(1);
  const { beginAdminDecrease, applyAdminDecrease } =
    await import("../convex/money/sourceAdjustments");
  const close = await t.run((ctx) =>
    beginAdminDecrease(ctx, f.walletId, 100, "capacity-decrease"),
  );
  await t.run((ctx) => drain(ctx, f.walletId));
  expect(
    await t.run((ctx) =>
      applyAdminDecrease(ctx, f.walletId, close.close!.id, 100),
    ),
  ).toMatchObject({
    status: "applied",
    wallet: { balance: 3400, lockedCredits: 3300, gateState: "open" },
  });
  await t.run((ctx) => assertWallet(ctx, f.walletId));
});
