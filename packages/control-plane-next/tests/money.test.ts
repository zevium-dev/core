import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { harness, webhook, webhookSecret, identity } from "./helpers";
import { moneyFixture, eventFor, assertWallet, paidLot } from "./moneyFixtures";
import { internal, api } from "../convex/_generated/api";
import { grantLot, allocate, sourceRow } from "../convex/money/lots";
import { appendWalletEntry } from "../convex/money/walletLedger";
import {
  acknowledgeDrain,
  finishClose,
  requestClose,
} from "../convex/money/barrier";
import { beginDustMerge, moveDustPage } from "../convex/money/dust";
import {
  reverseSource,
  restoreSource,
} from "../convex/money/sourceAdjustments";
import { admissionFingerprint, admissionFacts } from "../contracts/transport";
import { SECRET, NOW } from "./fixtures";
import type { Harness } from "./helpers";
import type { Id } from "../convex/_generated/dataModel";
import type { Settlement } from "../contracts/settlement";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_ADMISSION_SECRET", SECRET);
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
  vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
  vi.stubEnv("CLERK_WEBHOOK_SIGNING_SECRET", webhookSecret);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const settle = (t: Harness, event: Settlement) =>
  t.mutation(internal.wallets.settleEvent, {
    eventJson: JSON.stringify(event),
  });
async function resign(event: Settlement) {
  event.admissionFingerprint = await admissionFingerprint(
    admissionFacts(event),
    SECRET,
  );
  return event;
}
async function ack(t: Harness, walletId: Id<"wallets">, final?: number) {
  const wallet = (await t.run((ctx) => ctx.db.get(walletId)))!,
    close = wallet.close!;
  const value = {
    protocolVersion: 2,
    deploymentId: "next-fixture",
    walletId,
    ownerKey: wallet.ownerKey,
    epoch: wallet.epoch,
    gateRevision: wallet.gateRevision,
    closeId: close.id,
    requestedAt: close.requestedAt,
    reason: close.reason,
    edgeFinalSequence: final ?? wallet.settledThroughEdgeSequence,
    settledThroughEdgeSequence: final ?? wallet.settledThroughEdgeSequence,
    sealedAt: Date.now(),
  };
  return t.run((ctx) => acknowledgeDrain(ctx, value));
}
describe("wallet ledger and source inventory", () => {
  it("atomically grants the first signed creation, including replay and deleted identities", async () => {
    const t = harness();
    const event = {
      id: "org_one",
      name: "One",
      slug: "one",
      created_by: "user_one",
      updated_at: NOW,
    };
    await t
      .withIdentity(identity())
      .mutation(api.organizations.ensureOrganization, {
        clerkOrgId: "org_one",
      });
    for (const eventId of ["one", "one", "duplicate"])
      expect(
        (await webhook(t, eventId, "organization.created", event)).status,
      ).toBe(200);
    await webhook(t, "later", "organization.created", {
      ...event,
      id: "org_two",
    });
    await webhook(t, "delete", "user.deleted", { id: "user_one" });
    await webhook(t, "recreate", "organization.created", {
      ...event,
      id: "org_three",
    });
    const wallets = await t.run((ctx) => ctx.db.query("wallets").collect());
    expect(wallets).toHaveLength(1);
    expect(
      await t.run((ctx) => assertWallet(ctx, wallets[0]._id)),
    ).toMatchObject({ balance: 10000, entries: 1, lots: 1 });
    expect(
      (await t.run((ctx) => ctx.db.query("fundingLots").first()))?.refundable,
    ).toBe(false);
  });
  it("rejects changed grant facts and integer overflow, returning canonical replay state", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx));
    const grant = {
      walletId: f.walletId,
      sourceKind: "admin" as const,
      sourceRef: "money:0",
      credits: 100,
    };
    expect((await t.run((ctx) => grantLot(ctx, grant))).applied).toBe(false);
    await expect(
      t.run((ctx) => grantLot(ctx, { ...grant, credits: 101 })),
    ).rejects.toThrow("facts changed");
    await expect(
      t.run((ctx) =>
        grantLot(ctx, {
          ...grant,
          sourceRef: "overflow",
          credits: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).rejects.toThrow("accounting");
    await t.run((ctx) => assertWallet(ctx, f.walletId));
    const entry = (await t.run((ctx) =>
      ctx.db.query("walletEntries").first(),
    ))!;
    if (entry.kind !== "grant") throw new Error("fixture");
    await expect(
      t.run((ctx) =>
        appendWalletEntry(ctx, {
          walletId: f.walletId,
          kind: "grant",
          refId: entry.refId,
          amount: 99,
          lotId: entry.lotId,
          originLotId: entry.originLotId,
        }),
      ),
    ).rejects.toThrow("facts changed");
  });
  it("consumes promo first then admin and paid FIFO, with exact 32-source capacity", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "fifo", [1, 2]));
    await t.run((ctx) => paidLot(ctx, f.walletId, "paid", 100));
    const promo = await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "promo",
        sourceRef: "promo",
        credits: 4,
      }),
    );
    const slices = await t.run((ctx) => allocate(ctx, f.walletId, 8));
    expect(slices[0].lotId).toBe(promo.lot._id);
    expect(slices.map((s) => s.credits)).toEqual([4, 1, 2, 1]);
    const fragmented = await t.run((ctx) =>
      moneyFixture(ctx, "fragmented", Array<number>(33).fill(1), 32),
    );
    expect(
      await t.run((ctx) => allocate(ctx, fragmented.walletId, 32)),
    ).toHaveLength(32);
    await expect(
      t.run((ctx) => allocate(ctx, fragmented.walletId, 33)),
    ).rejects.toThrow("capacity");
    const empty = await t.run((ctx) => moneyFixture(ctx, "empty", []));
    await expect(
      t.run((ctx) => allocate(ctx, empty.walletId, 0)),
    ).rejects.toThrow("Insufficient");
  });
  it("conserves randomized grant/settle/replay sequences against a reference balance", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "random", [50], 1));
    let balance = 50,
      state = 17,
      seq = 0;
    for (let i = 0; i < 60; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (state % 4 === 0) {
        const credits = (state % 17) + 1;
        await t.run((ctx) =>
          grantLot(ctx, {
            walletId: f.walletId,
            sourceKind: "promo",
            sourceRef: `random:${i}:promo`,
            credits,
          }),
        );
        balance += credits;
      } else {
        const event = await t.run((ctx) => eventFor(ctx, f, ++seq));
        expect((await settle(t, event)).status).toBe("applied");
        expect((await settle(t, event)).status).toBe("already_applied");
        balance--;
      }
      expect(
        (await t.run((ctx) => assertWallet(ctx, f.walletId))).balance,
      ).toBe(balance);
    }
  });
});
describe("source-backed settlement v2", () => {
  it("persists exact 95/5 earnings and rollups once without touching publisher balances", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "split", [1], 1));
    const event = await t.run((ctx) => eventFor(ctx, f));
    expect((await settle(t, event)).status).toBe("applied");
    expect((await settle(t, event)).status).toBe("already_applied");
    const earning = (await t.run((ctx) =>
      ctx.db.query("publisherEarnings").first(),
    ))!;
    expect(earning).toMatchObject({
      grossCredits: 1,
      netAtoms: 9500,
      platformFeeAtoms: 500,
    });
    expect(earning.availableAt - Date.now()).toBeGreaterThanOrEqual(
      7 * 86400000,
    );
    expect(
      await t.run((ctx) => ctx.db.query("publisherBalances").collect()),
    ).toEqual([]);
    const rows = await t.run((ctx) => ctx.db.query("usageRollups").collect());
    expect(
      rows.filter(
        (r) =>
          r.kind === "lifetime" &&
          r.scope === "publisher" &&
          r.dimension === "total",
      )[0],
    ).toMatchObject({
      calls: 1,
      grossCredits: 1,
      netAtoms: 9500,
      pendingRiskAtoms: 9500,
    });
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
  it.each(["refunded", "free", "zero"] as const)(
    "records %s with empty consumed slices and no debit",
    async (kind) => {
      const t = harness(),
        f = await t.run((ctx) => moneyFixture(ctx));
      const patch: Partial<Settlement> =
        kind === "refunded"
          ? {
              credits: 0,
              billingOutcome: "refunded",
              qualityOutcome: "server_error",
              status: 500,
            }
          : kind === "free"
            ? {
                credits: 0,
                heldCredits: 0,
                fundingSlices: [],
                billingOutcome: "free",
                pricingDecision: "free_tier",
                freeTierUsedBefore: 0,
              }
            : {
                credits: 0,
                heldCredits: 0,
                listedCostCredits: 0,
                fundingSlices: [],
                billingOutcome: "free",
                pricingDecision: "zero_price",
                operationId: "free",
                endpoint: "/free",
                method: "GET",
                freeTierLimit: undefined,
              };
      const event = await t.run((ctx) => eventFor(ctx, f, 1, patch));
      expect((await settle(t, event)).status).toBe("applied");
      const usage = (await t.run((ctx) =>
        ctx.db.query("usageEvents").first(),
      ))!;
      expect(usage.fundingSlices).toEqual([]);
      expect(
        await t.run((ctx) => ctx.db.query("publisherEarnings").collect()),
      ).toEqual([]);
      expect(
        (await t.run((ctx) => assertWallet(ctx, f.walletId))).balance,
      ).toBe(100);
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("usageRollups")
            .withIndex("by_consumer_project", (q) =>
              q.eq("kind", "lifetime_consumer_project"),
            )
            .collect(),
        ),
      ).toHaveLength(kind === "refunded" ? 0 : 1);
    },
  );
  it("rejects signed spoofed immutable identities, changed replay and sequence collisions", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx));
    const event = await t.run((ctx) => eventFor(ctx, f));
    for (const patch of [
      { ownerUserId: "forged" },
      {
        listedCostCredits: 6,
        credits: 6,
        heldCredits: 6,
        fundingSlices: event.fundingSlices.map((s) => ({ ...s, credits: 6 })),
      },
      { publisherOrganizationId: f.consumer },
      { specDigest: "b".repeat(64) },
      { keyFamilyId: "forged" },
      { freeTierLimit: 3 },
      { deploymentId: "other" },
    ]) {
      expect(
        (await settle(t, await resign({ ...event, ...patch }))).status,
      ).toBe("rejected");
    }
    expect(
      (await settle(t, { ...event, admissionFingerprint: "0".repeat(64) }))
        .status,
    ).toBe("rejected");
    expect((await settle(t, event)).status).toBe("applied");
    expect((await settle(t, { ...event, latencyMs: 11 })).status).toBe(
      "rejected",
    );
    expect(
      (
        await settle(
          t,
          await resign({
            ...event,
            reservationId: "collision",
            settleRefId: "settle:collision",
          }),
        )
      ).status,
    ).toBe("rejected");
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
  it("preserves served-call settlement through revocation, retirement and archive before drained reversal", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx));
    const event = await t.run((ctx) => eventFor(ctx, f));
    const begin = await t.mutation(internal.wallets.beginDecrease, {
      walletId: f.walletId,
      credits: 95,
    });
    await expect(
      t.mutation(internal.wallets.applyDecrease, {
        walletId: f.walletId,
        ref: begin.closeId!,
        credits: 95,
      }),
    ).rejects.toThrow("drained");
    await expect(ack(t, f.walletId, 1)).rejects.toThrow("not drained");
    await t.run(async (ctx) => {
      await ctx.db.patch(f.consumer, { archivedAt: Date.now() });
      await ctx.db.patch(f.project, { visibility: "private", status: "draft" });
      const key = (await ctx.db
        .query("apiKeys")
        .withIndex("by_key", (q) => q.eq("keyId", f.keyId))
        .unique())!;
      await ctx.db.patch(key._id, {
        revokedAt: Date.now(),
        lifecycle: "disabled",
      });
    });
    expect((await settle(t, event)).status).toBe("applied");
    await ack(t, f.walletId, 1);
    const args = { walletId: f.walletId, ref: begin.closeId!, credits: 95 };
    expect(
      (await t.mutation(internal.wallets.applyDecrease, args)).balance,
    ).toBe(0);
    expect(
      (await t.mutation(internal.wallets.applyDecrease, args)).gateState,
    ).toBe("closed");
    await expect(
      t.mutation(internal.wallets.applyDecrease, { ...args, credits: 94 }),
    ).rejects.toThrow("facts changed");
    expect((await settle(t, event)).status).toBe("already_applied");
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
  it("keeps sequence gaps retryable, admits no overspend and progresses beyond 100 finals", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "many", [150], 1));
    const events = [];
    for (let seq = 1; seq <= 105; seq++)
      events.push(await t.run((ctx) => eventFor(ctx, f, seq)));
    expect(await settle(t, events[1])).toMatchObject({
      status: "rejected",
      retryable: true,
    });
    for (const batch of [events.slice(0, 100).reverse(), events.slice(100)]) {
      const response = await t.action(internal.wallets.recordUsage, {
        bodyJson: JSON.stringify({ events: batch }),
      });
      expect(response.results.every((r) => r.status === "applied")).toBe(true);
    }
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      45,
    );
    const last = await t.run((ctx) => moneyFixture(ctx, "last", [5], 5));
    const first = await t.run((ctx) => eventFor(ctx, last)),
      second = await t.run((ctx) => eventFor(ctx, last, 2));
    expect((await settle(t, first)).status).toBe("applied");
    expect((await settle(t, second)).status).toBe("rejected");
    await t.run((ctx) => assertWallet(ctx, last.walletId));
  });
  it("validates HTTP size/auth/deferred fields and keeps the checkpoint envelope", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx)),
      event = await t.run((ctx) => eventFor(ctx, f));
    const request = (body: unknown, secret = SECRET) =>
      t.fetch("/ingest-usage", {
        method: "POST",
        headers: { "x-internal-secret": secret },
        body: JSON.stringify(body),
      });
    expect((await request({ events: [event] }, "bad")).status).toBe(401);
    expect(
      (await request({ events: [{ ...event, tokenUsage: {} }] })).status,
    ).toBe(400);
    expect((await request({ events: Array(101).fill(event) })).status).toBe(
      400,
    );
    const response = await request({ events: [event] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ status: "applied" }],
      wallet: { balance: 95, sequence: 2 },
    });
  });
});
describe("dust moves and exact restoration", () => {
  it("merges 999 but not 1000 credits into the newest compatible container, with zero wallet delta", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "dust", [999]));
    vi.advanceTimersByTime(1);
    const threshold = await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "admin",
        sourceRef: "threshold",
        credits: 1000,
      }),
    );
    vi.advanceTimersByTime(1);
    const newest = await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "admin",
        sourceRef: "newest",
        credits: 1000,
      }),
    );
    expect(
      await t.run((ctx) => beginDustMerge(ctx, threshold.lot._id)),
    ).toBeNull();
    const job = (await t.run((ctx) => beginDustMerge(ctx, f.lots[0])))!;
    expect(job.merge!.toLotId).toBe(newest.lot._id);
    expect(
      await t.run((ctx) => moveDustPage(ctx, job._id, job.merge!.generation)),
    ).toMatchObject({ waiting: true });
    await ack(t, f.walletId);
    expect(
      await t.run((ctx) => moveDustPage(ctx, job._id, job.merge!.generation)),
    ).toMatchObject({ complete: true });
    expect(
      await t.run((ctx) => moveDustPage(ctx, job._id, job.merge!.generation)),
    ).toMatchObject({ complete: true });
    const entries = await t.run((ctx) =>
      ctx.db.query("walletEntries").collect(),
    );
    expect(entries.filter((e) => e.kind === "lot_move")).toMatchObject([
      { amount: 0, movedCredits: 999, sourceRef: "dust:0" },
    ]);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      2999,
    );
  });
  it("never merges promo into paid or unequal deadlines and supports a configurable threshold", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "compat", []));
    const promo = await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "promo",
        sourceRef: "promo",
        credits: 500,
      }),
    );
    vi.advanceTimersByTime(1);
    const paid = await t.run((ctx) => paidLot(ctx, f.walletId, "paid", 500));
    expect(await t.run((ctx) => beginDustMerge(ctx, promo.lot._id))).toBeNull();
    vi.advanceTimersByTime(1);
    const other = await t.run((ctx) => paidLot(ctx, f.walletId, "other", 1000));
    await t.run(async (ctx) => {
      await ctx.db.patch(paid.lot._id, {
        expiryClass: `at:${NOW + 10000}`,
        expiresAt: NOW + 10000,
      });
      await ctx.db.patch(other.lot._id, {
        expiryClass: `at:${NOW + 20000}`,
        expiresAt: NOW + 20000,
      });
    });
    expect(await t.run((ctx) => beginDustMerge(ctx, paid.lot._id))).toBeNull();
    await t.run((ctx) =>
      ctx.db.patch(other.lot._id, {
        expiryClass: `at:${NOW + 10000}`,
        expiresAt: NOW + 10000,
      }),
    );
    expect(
      await t.run((ctx) => beginDustMerge(ctx, paid.lot._id, 500)),
    ).toBeNull();
    expect(
      await t.run((ctx) => beginDustMerge(ctx, paid.lot._id, 501)),
    ).not.toBeNull();
  });
  it("preserves original payment earnings and refund attribution after repeated moves", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "origins", [], 100));
    const a = await t.run((ctx) => paidLot(ctx, f.walletId, "payment:a", 200));
    vi.advanceTimersByTime(1);
    const b = await t.run((ctx) => paidLot(ctx, f.walletId, "payment:b", 200));
    for (const source of [a.lot, b.lot]) {
      if (source._id === b.lot._id) {
        vi.advanceTimersByTime(1);
        await t.run((ctx) => paidLot(ctx, f.walletId, "payment:c", 200));
      }
      const job = (await t.run((ctx) => beginDustMerge(ctx, source._id)))!;
      await ack(t, f.walletId);
      await t.run((ctx) =>
        moveDustPage(ctx, source._id, job.merge!.generation),
      );
    }
    const event = await t.run((ctx) => eventFor(ctx, f));
    expect(event.fundingSlices[0]).toMatchObject({
      sourceRef: "payment:a",
      paymentId: a.lot.paymentId,
      originLotId: a.lot._id,
    });
    expect(event.fundingSlices[0].lotId).not.toBe(a.lot._id);
    expect((await settle(t, event)).status).toBe("applied");
    expect(
      (await t.run((ctx) => ctx.db.query("publisherEarnings").first()))
        ?.paymentId,
    ).toBe(a.lot.paymentId);
    await t.run((ctx) => requestClose(ctx, f.walletId, "refund:a", "refund"));
    await ack(t, f.walletId);
    const adjustment = await t.run((ctx) =>
      ctx.db.insert("paymentAdjustments", {
        paymentId: a.lot.paymentId!,
        providerSourceRef: "refund:a",
        kind: "refund",
        status: "succeeded",
        principalCents: 1,
        feeCents: 0,
        requestedCredits: 100,
        effectiveCredits: 100,
        fundsWithdrawn: false,
        fundsReinstated: false,
        revision: 1,
        appliedWalletCredits: 0,
        appliedPublisherCredits: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const located = await t.run((ctx) =>
      ctx.db
        .query("fundingLotSources")
        .withIndex("by_payment", (q) => q.eq("paymentId", a.lot.paymentId))
        .collect(),
    );
    const remaining = located.find((s) => s.remainingCredits > 0)!;
    const input = {
      walletId: f.walletId,
      closeId: "refund:a",
      refId: "reverse:a",
      slice: {
        lotId: remaining.lotId,
        originLotId: remaining.originLotId,
        sourceRef: remaining.sourceRef,
        paymentId: remaining.paymentId,
        credits: 100,
      },
      adjustment: { kind: "payment" as const, id: adjustment },
      requestFingerprint: "verified-refund-fact",
    };
    const reversed = await t.run((ctx) => reverseSource(ctx, input));
    expect((await t.run((ctx) => reverseSource(ctx, input))).applied).toBe(
      false,
    );
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      400,
    );
    await t.run((ctx) =>
      restoreSource(
        ctx,
        reversed.entry,
        `restore:${reversed.entry.refId}`,
        "refund:a",
      ),
    );
    expect(
      (
        await t.run((ctx) =>
          restoreSource(
            ctx,
            reversed.entry,
            `restore:${reversed.entry.refId}`,
            "refund:a",
          ),
        )
      ).applied,
    ).toBe(false);
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      500,
    );
    expect(
      (
        await t.run((ctx) =>
          sourceRow(ctx, remaining.lotId, remaining.originLotId),
        )
      )?.remainingCredits,
    ).toBe(100);
  });
  it("pages merged provenance beyond 32 without relaxing per-call capacity, and resumes after interruption", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "merged", [1], 1));
    let container = f.lots[0];
    for (let i = 1; i < 34; i++) {
      vi.advanceTimersByTime(1);
      const next = await t.run((ctx) =>
        grantLot(ctx, {
          walletId: f.walletId,
          sourceKind: "admin",
          sourceRef: `merged:new:${i}`,
          credits: 1,
        }),
      );
      const job = (await t.run((ctx) => beginDustMerge(ctx, container)))!;
      await ack(t, f.walletId);
      const first = await t.run((ctx) =>
        moveDustPage(ctx, container, job.merge!.generation),
      );
      if (!first.complete) {
        expect(i).toBe(33);
        expect((await t.run((ctx) => ctx.db.get(f.walletId)))?.gateState).toBe(
          "closing",
        );
        await t.run((ctx) => assertWallet(ctx, f.walletId));
        await t.run((ctx) =>
          moveDustPage(ctx, container, job.merge!.generation),
        );
      }
      container = next.lot._id;
    }
    expect(await t.run((ctx) => allocate(ctx, f.walletId, 32))).toHaveLength(
      32,
    );
    await expect(t.run((ctx) => allocate(ctx, f.walletId, 33))).rejects.toThrow(
      "capacity",
    );
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
  it("restores recorded admin sources, including expiry as platform breakage", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "restore", [100]));
    const begin = await t.mutation(internal.wallets.beginDecrease, {
      walletId: f.walletId,
      credits: 25,
    });
    await ack(t, f.walletId);
    await t.mutation(internal.wallets.applyDecrease, {
      walletId: f.walletId,
      ref: begin.closeId!,
      credits: 25,
    });
    await t.run((ctx) => requestClose(ctx, f.walletId, "restore", "admin"));
    await ack(t, f.walletId);
    const args = {
      walletId: f.walletId,
      ref: begin.closeId!,
      closeId: "restore",
    };
    expect(
      (await t.mutation(internal.wallets.restoreDecrease, args)).balance,
    ).toBe(100);
    expect(
      (await t.mutation(internal.wallets.restoreDecrease, args)).balance,
    ).toBe(100);
    const again = await t.mutation(internal.wallets.beginDecrease, {
      walletId: f.walletId,
      credits: 100,
    });
    await ack(t, f.walletId);
    await t.mutation(internal.wallets.applyDecrease, {
      walletId: f.walletId,
      ref: again.closeId!,
      credits: 100,
    });
    await t.run((ctx) =>
      ctx.db.patch(f.lots[0], { expiresAt: NOW, expiryClass: `at:${NOW}` }),
    );
    await t.run((ctx) =>
      requestClose(ctx, f.walletId, "expired-restore", "admin"),
    );
    await ack(t, f.walletId);
    expect(
      (
        await t.mutation(internal.wallets.restoreDecrease, {
          walletId: f.walletId,
          ref: again.closeId!,
          closeId: "expired-restore",
        })
      ).balance,
    ).toBe(0);
    const expiry = (
      await t.run((ctx) => ctx.db.query("walletEntries").collect())
    ).find((e) => e.kind === "expiry");
    expect(expiry).toMatchObject({ amount: -100, breakageCredits: 100 });
    expect(
      await t.run((ctx) => ctx.db.query("publisherEarnings").collect()),
    ).toEqual([]);
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  });
});
it("keeps partial-batch failure retryable and preserves accepted refs through a lost ACK", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "partial", [20], 5));
  const events = await Promise.all(
    [1, 2, 3].map((seq) => t.run((ctx) => eventFor(ctx, f, seq))),
  );
  const corrupted = { ...events[1], admissionFingerprint: "0".repeat(64) };
  const first = await t.action(internal.wallets.recordUsage, {
    bodyJson: JSON.stringify({ events: [events[0], corrupted, events[2]] }),
  });
  expect(first.results.map((r) => r.status)).toEqual([
    "applied",
    "rejected",
    "rejected",
  ]);
  const retry = await t.action(internal.wallets.recordUsage, {
    bodyJson: JSON.stringify({ events }),
  });
  expect(retry.results.map((r) => r.status)).toEqual([
    "already_applied",
    "applied",
    "applied",
  ]);
  expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(5);
});
it("redacts usage under signed member ownership and returns bounded filtered pages", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx));
  const event = await t.run((ctx) => eventFor(ctx, f));
  await settle(t, event);
  const claims = {
    subject: f.ownerUserId,
    org_id: event.consumerClerkOrgId,
    org_role: "org:member",
  };
  const member = t.withIdentity(claims);
  const page = await member.query(api.usage.listForOrg, {
    orgSlug: "ignored",
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(page.page).toHaveLength(1);
  expect(page.page[0]).not.toHaveProperty("memberId");
  expect(page.page[0].keyId).not.toBe(f.keyId);
  expect(
    await t
      .withIdentity({ ...claims, subject: "other" })
      .query(api.usage.getForOrgById, {
        orgSlug: "ignored",
        eventId: page.page[0].eventId,
      }),
  ).toBeNull();
  expect(
    await t
      .withIdentity({ ...claims, org_id: `org_other` })
      .query(api.usage.getForOrgById, {
        orgSlug: "ignored",
        eventId: page.page[0].eventId,
      })
      .catch(() => null),
  ).toBeNull();
  expect(
    await member.query(api.usage.getForOrgById, {
      orgSlug: "ignored",
      eventId: page.page[0].eventId,
    }),
  ).toEqual(page.page[0]);
});
it("requires exact drain evidence and never lets an old ACK advance the next epoch", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx));
  await t.run((ctx) => requestClose(ctx, f.walletId, "test-close", "admin"));
  const w = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  const proof = {
    protocolVersion: 2,
    deploymentId: "next-fixture",
    walletId: w._id,
    ownerKey: w.ownerKey,
    epoch: w.epoch,
    gateRevision: w.gateRevision,
    closeId: w.close!.id,
    requestedAt: w.close!.requestedAt,
    reason: w.close!.reason,
    edgeFinalSequence: 0,
    settledThroughEdgeSequence: 0,
    sealedAt: Date.now(),
  };
  await t.run((ctx) => acknowledgeDrain(ctx, proof));
  await t.run((ctx) => finishClose(ctx, f.walletId, proof.closeId));
  expect((await t.run((ctx) => acknowledgeDrain(ctx, proof))).epoch).toBe(2);
  await expect(
    t.run((ctx) => acknowledgeDrain(ctx, { ...proof, gateRevision: 999 })),
  ).rejects.toThrow("facts changed");
  expect((await t.run((ctx) => ctx.db.get(f.walletId)))?.epoch).toBe(2);
});
