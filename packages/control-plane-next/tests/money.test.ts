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
  it("matches a source reference model across randomized money and maintenance sequences", async () => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "model", [], 7));
    type Source = {
      ref: string;
      container: Id<"fundingLots">;
      origin: Id<"fundingLots">;
      priority: number;
      order: number;
      containerOrder: number;
      remaining: number;
      consumed: number;
      reversed: number;
    };
    const model: Source[] = [];
    let ordinal = 0,
      state = 17,
      sequence = 0,
      expectedSpent = 0;
    const random = () =>
      (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const grant = async (
      kind: "promo" | "admin" | "payment",
      amount: number,
    ) => {
      vi.advanceTimersByTime(1);
      const order = ++ordinal,
        ref = `model:${order}`;
      const result =
        kind === "payment"
          ? await t.run((ctx) => paidLot(ctx, f.walletId, ref, amount))
          : await t.run((ctx) =>
              grantLot(ctx, {
                walletId: f.walletId,
                sourceKind: kind,
                sourceRef: ref,
                credits: amount,
              }),
            );
      model.push({
        ref,
        origin: result.lot._id,
        container: result.lot._id,
        priority: kind === "promo" ? 0 : kind === "admin" ? 1 : 2,
        order,
        containerOrder: order,
        remaining: amount,
        consumed: 0,
        reversed: 0,
      });
    };
    const allocation = (amount: number) => {
      let left = amount;
      const slices: { source: Source; credits: number }[] = [];
      for (const source of [...model].sort(
        (a, b) =>
          a.priority - b.priority ||
          a.containerOrder - b.containerOrder ||
          a.order - b.order,
      )) {
        const credits = Math.min(left, source.remaining);
        if (credits) {
          slices.push({ source, credits });
          left -= credits;
        }
        if (!left) break;
      }
      expect(left).toBe(0);
      return slices;
    };
    await grant("admin", 100);
    await grant("admin", 100);
    await grant("payment", 200);
    await grant("promo", 80);
    const visited = new Set<number>();
    for (let i = 0; i < 70; i++) {
      // Shuffle each seven-operation round, guaranteeing coverage without a fixed operation sequence.
      const choices = Array.from({ length: 7 }, (_, n) => n).filter(
        (n) => !visited.has(n),
      );
      const op = choices[random() % choices.length];
      visited.add(op);
      if (visited.size === 7) visited.clear();
      if (op === 0)
        await grant(
          (["promo", "admin", "payment"] as const)[random() % 3],
          20 + (random() % 40),
        );
      if (op >= 1 && op <= 3) {
        const selected = allocation(7);
        const patch: Partial<Settlement> =
          op === 2
            ? {
                billingOutcome: "refunded",
                qualityOutcome: "server_error",
                status: 500,
                credits: 0,
              }
            : op === 3
              ? {
                  billingOutcome: "free",
                  pricingDecision: "free_tier",
                  heldCredits: 0,
                  credits: 0,
                  fundingSlices: [],
                  freeTierUsedBefore: 0,
                }
              : {};
        const event = await t.run((ctx) => eventFor(ctx, f, ++sequence, patch));
        if (op !== 3)
          expect(
            event.fundingSlices.map((s) => [s.sourceRef, s.lotId, s.credits]),
          ).toEqual(
            selected.map((s) => [s.source.ref, s.source.container, s.credits]),
          );
        expect((await settle(t, event)).status).toBe("applied");
        expect((await settle(t, event)).status).toBe("already_applied");
        if (op === 1) {
          expectedSpent += 7;
          for (const { source, credits } of selected) {
            source.remaining -= credits;
            source.consumed += credits;
          }
        }
      }
      if (op === 4) {
        // Merge compatible admin containers; model explicitly moves provenance and spend order.
        await grant("admin", 20);
        const containers = [
          ...new Set(
            model
              .filter((s) => s.priority === 1 && s.remaining > 0)
              .map((s) => s.container),
          ),
        ];
        const sourceId = containers.sort(
          (a, b) =>
            model.find((s) => s.container === a)!.containerOrder -
            model.find((s) => s.container === b)!.containerOrder,
        )[0];
        const target = model[model.length - 1];
        const job = (await t.run((ctx) => beginDustMerge(ctx, sourceId)))!;
        expect(job.merge?.toLotId).toBe(target.container);
        await ack(t, f.walletId);
        let done = false;
        while (!done)
          done = (
            await t.run((ctx) =>
              moveDustPage(ctx, sourceId, job.merge!.generation),
            )
          ).complete;
        for (const source of model.filter(
          (s) => s.container === sourceId && s.remaining > 0,
        )) {
          source.container = target.container;
          source.containerOrder = target.containerOrder;
        }
        sequence = 0;
      }
      if (op === 5) {
        const credits = 1 + (random() % 9),
          selected = allocation(credits);
        const begin = await t.mutation(internal.wallets.beginDecrease, {
          walletId: f.walletId,
          credits,
          operationId: `model:${i}`,
        });
        await ack(t, f.walletId);
        expect(
          await t.mutation(internal.wallets.applyDecrease, {
            walletId: f.walletId,
            ref: begin.closeId!,
            credits,
          }),
        ).toMatchObject({ status: "applied" });
        for (const { source, credits: n } of selected) {
          source.remaining -= n;
          source.reversed += n;
        }
        sequence = 0;
      }
      if (op === 6) {
        // A source-specific payment reversal/restoration uses a bound generation and exact journal ref.
        const source = model.find((s) => s.priority === 2 && s.remaining > 3)!;
        const lot = (await t.run((ctx) => ctx.db.get(source.origin)))!;
        const closeId = `model-refund:${i}`;
        await t.run((ctx) => requestClose(ctx, f.walletId, closeId, "refund"));
        await ack(t, f.walletId);
        const adjustmentId = await t.run((ctx) =>
          ctx.db.insert("paymentAdjustments", {
            paymentId: lot.paymentId!,
            providerSourceRef: closeId,
            kind: "refund",
            status: "succeeded",
            principalCents: 0.03,
            feeCents: 0,
            requestedCredits: 3,
            effectiveCredits: 3,
            fundsWithdrawn: false,
            fundsReinstated: false,
            revision: 1,
            appliedWalletCredits: 0,
            appliedPublisherCredits: 0,
            closeId,
            closeGeneration: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        );
        const input = {
          walletId: f.walletId,
          closeId,
          refId: `reverse:${i}`,
          requestFingerprint: `model:${i}`,
          adjustment: { kind: "payment" as const, id: adjustmentId },
          slice: {
            lotId: source.container,
            originLotId: source.origin,
            sourceRef: source.ref,
            paymentId: lot.paymentId,
            credits: 3,
          },
        };
        await expect(
          t.run((ctx) => reverseSource(ctx, { ...input, closeId: "wrong" })),
        ).rejects.toThrow("drained");
        const result = await t.run((ctx) => reverseSource(ctx, input));
        source.remaining -= 3;
        source.reversed += 3;
        await t.run((ctx) => assertWallet(ctx, f.walletId));
        await t.run((ctx) =>
          restoreSource(ctx, result.entry, `restore:${input.refId}`, closeId),
        );
        source.remaining += 3;
        source.reversed -= 3;
        await t.run((ctx) => finishClose(ctx, f.walletId, closeId));
        sequence = 0;
        // Both primitives replay after completion, without re-opening the close.
        expect((await t.run((ctx) => reverseSource(ctx, input))).applied).toBe(
          false,
        );
        expect(
          (
            await t.run((ctx) =>
              restoreSource(
                ctx,
                result.entry,
                `restore:${input.refId}`,
                closeId,
              ),
            )
          ).applied,
        ).toBe(false);
        await expect(
          t.run((ctx) => reverseSource(ctx, { ...input, closeId: "wrong" })),
        ).rejects.toThrow("facts changed");
      }
      expect(
        (await t.run((ctx) => assertWallet(ctx, f.walletId))).balance,
      ).toBe(model.reduce((n, s) => n + s.remaining, 0));
      const rows = await t.run((ctx) =>
        ctx.db.query("fundingLotSources").collect(),
      );
      for (const source of model) {
        const originals = rows.filter((r) => r.sourceRef === source.ref);
        expect(originals.reduce((n, r) => n + r.remainingCredits, 0)).toBe(
          source.remaining,
        );
        expect(originals.reduce((n, r) => n + r.consumedCredits, 0)).toBe(
          source.consumed,
        );
        expect(originals.reduce((n, r) => n + r.reversedCredits, 0)).toBe(
          source.reversed,
        );
      }
      const earnings = await t.run((ctx) =>
        ctx.db.query("publisherEarnings").collect(),
      );
      expect(earnings.reduce((n, e) => n + e.grossCredits, 0)).toBe(
        expectedSpent,
      );
      expect(earnings.reduce((n, e) => n + e.netAtoms, 0)).toBe(
        expectedSpent * 9500,
      );
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
    let poisonedSequence = 0;
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
      const poisoned = await resign({
        ...event,
        ...patch,
        edgeSequence: ++poisonedSequence,
        reservationId: `poison:${poisonedSequence}`,
        settleRefId: `settle:poison:${poisonedSequence}`,
      });
      const expected = patch.deploymentId ? "rejected" : "exception";
      expect((await settle(t, poisoned)).status).toBe(expected);
      expect((await settle(t, poisoned)).status).toBe(expected);
    }
    expect(
      (await settle(t, { ...event, admissionFingerprint: "0".repeat(64) }))
        .status,
    ).toBe("rejected");
    event.edgeSequence = poisonedSequence;
    await resign(event);
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
      operationId: "archive-decrease",
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
    expect((await settle(t, second)).status).toBe("exception");
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
        closeId: "refund:a",
        closeGeneration: 0,
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
    await t.run((ctx) => ctx.db.patch(adjustment, { closeId: "unrelated" }));
    await expect(t.run((ctx) => reverseSource(ctx, input))).rejects.toThrow(
      "source mismatch",
    );
    await t.run((ctx) =>
      ctx.db.patch(adjustment, { closeId: "refund:a", closeGeneration: 1 }),
    );
    await expect(t.run((ctx) => reverseSource(ctx, input))).rejects.toThrow(
      "source mismatch",
    );
    await t.run((ctx) => ctx.db.patch(adjustment, { closeGeneration: 0 }));
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
      operationId: "restore-first",
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
      operationId: "restore-expired",
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
    await t.mutation(internal.wallets.restoreDecrease, {
      walletId: f.walletId,
      ref: again.closeId!,
      closeId: "expired-restore",
    });
    const breakage = await t.run((ctx) =>
      ctx.db.query("usageRollups").collect(),
    );
    for (const kind of ["daily", "lifetime"] as const) {
      expect(
        breakage
          .filter((r) => r.kind === kind && r.scope === "platform")
          .reduce(
            (sum, r) =>
              sum + ("breakageAtoms" in r ? (r.breakageAtoms ?? 0) : 0),
            0,
          ),
      ).toBe(1000000);
    }
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

it.each([90_000, -90_000])(
  "settles signed calls with %i ms Worker skew and drains",
  async (skew) => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx));
    const event = await t.run((ctx) =>
      eventFor(ctx, f, 1, {
        admittedAt: NOW + skew,
        at: NOW + skew,
        budgetPeriod: new Date(NOW + skew).toISOString().slice(0, 7),
      }),
    );
    expect((await settle(t, event)).status).toBe("applied");
    await t.run((ctx) => requestClose(ctx, f.walletId, "skew", "admin"));
    const w = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
    await t.run((ctx) =>
      acknowledgeDrain(ctx, {
        protocolVersion: 2,
        deploymentId: "next-fixture",
        walletId: w._id,
        ownerKey: w.ownerKey,
        epoch: w.epoch,
        gateRevision: w.gateRevision,
        closeId: "skew",
        requestedAt: w.close!.requestedAt,
        reason: "admin",
        edgeFinalSequence: 1,
        settledThroughEdgeSequence: 1,
        sealedAt: NOW + skew,
      }),
    );
    await t.run((ctx) => finishClose(ctx, f.walletId, "skew"));
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      95,
    );
  },
);

it.each(["resolved", "void"] as const)(
  "records depleted-source exceptions and operator %s without blocking later finals",
  async (disposition) => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "exception", [5]));
    const events = await t.run(async (ctx) => [
      await eventFor(ctx, f),
      await eventFor(ctx, f, 2),
    ]);
    expect((await settle(t, events[0])).status).toBe("applied");
    expect((await settle(t, events[1])).status).toBe("exception");
    expect((await settle(t, events[1])).status).toBe("exception");
    await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "admin",
        sourceRef: "next",
        credits: 5,
      }),
    );
    expect(
      (await settle(t, await t.run((ctx) => eventFor(ctx, f, 3)))).status,
    ).toBe("applied");
    const rows = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(rows.find((e) => e.billingOutcome === "exception")).toMatchObject({
      credits: 0,
      fundingSlices: [],
    });
    const cases = await t.run((ctx) =>
      ctx.db.query("financeReconciliationCases").collect(),
    );
    expect(cases.filter((c) => c.rowKind === "case")).toHaveLength(1);
    const args = {
      caseId: cases.find((c) => c.rowKind === "case")!._id,
      disposition,
      resolution: "Reviewed source evidence; no debit authorized",
    };
    expect(
      await t.mutation(internal.wallets.resolveSettlementException, args),
    ).toMatchObject({ status: "resolved" });
    expect(
      await t.mutation(internal.wallets.resolveSettlementException, args),
    ).toMatchObject({ status: "resolved" });
    await expect(
      t.mutation(internal.wallets.resolveSettlementException, {
        ...args,
        resolution: "changed",
      }),
    ).rejects.toThrow("facts changed");
    await t.run((ctx) =>
      requestClose(ctx, f.walletId, "drain-exception", "admin"),
    );
    await ack(t, f.walletId, 3);
    await t.run((ctx) => finishClose(ctx, f.walletId, "drain-exception"));
    expect((await t.run((ctx) => assertWallet(ctx, f.walletId))).balance).toBe(
      0,
    );
  },
);

it.each([{ projectId: "invalid-project" }, { at: Number.MAX_SAFE_INTEGER }])(
  "records malformed signed evidence %j without wedging the watermark",
  async (patch) => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx));
    const event = await t.run((ctx) => eventFor(ctx, f, 1, patch));
    expect((await settle(t, event)).status).toBe("exception");
    expect(
      (await settle(t, await t.run((ctx) => eventFor(ctx, f, 2)))).status,
    ).toBe("applied");
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  },
);

it("uses caller operation IDs for admin decreases across lost responses and equal amounts", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx));
  const args = { walletId: f.walletId, credits: 10, operationId: "first" };
  const begin = await t.mutation(internal.wallets.beginDecrease, args);
  expect(await t.mutation(internal.wallets.beginDecrease, args)).toEqual(begin);
  await ack(t, f.walletId);
  const applied = await t.mutation(internal.wallets.applyDecrease, {
    walletId: f.walletId,
    credits: 10,
    ref: begin.closeId!,
  });
  expect(await t.mutation(internal.wallets.beginDecrease, args)).toMatchObject({
    balance: 90,
    gateState: "open",
    epoch: applied.epoch,
  });
  await expect(
    t.mutation(internal.wallets.beginDecrease, { ...args, credits: 11 }),
  ).rejects.toThrow("facts changed");
  const next = await t.mutation(internal.wallets.beginDecrease, {
    ...args,
    operationId: "second",
  });
  expect(next.closeId).not.toBe(begin.closeId);
  await ack(t, f.walletId);
  await t.mutation(internal.wallets.applyDecrease, {
    walletId: f.walletId,
    credits: 10,
    ref: next.closeId!,
  });
  expect(await t.mutation(internal.wallets.beginDecrease, args)).toMatchObject({
    balance: 80,
    gateState: "open",
  });
  await t.run((ctx) => assertWallet(ctx, f.walletId));
});

it.each(["insufficient", "fragmented", "cancel"])(
  "reopens drained admin close on %s with no debit",
  async (mode) => {
    const t = harness(),
      f = await t.run((ctx) =>
        moneyFixture(
          ctx,
          mode,
          mode === "fragmented" ? Array<number>(33).fill(1) : [10],
        ),
      );
    const credits = mode === "fragmented" ? 33 : 11;
    const begin = await t.mutation(internal.wallets.beginDecrease, {
      walletId: f.walletId,
      credits,
      operationId: mode,
    });
    await expect(
      t.mutation(internal.wallets.abandonDecrease, {
        walletId: f.walletId,
        closeId: begin.closeId!,
      }),
    ).rejects.toThrow("drained");
    await ack(t, f.walletId);
    const args = { walletId: f.walletId, ref: begin.closeId!, credits };
    if (mode === "cancel")
      await t.mutation(internal.wallets.abandonDecrease, {
        walletId: f.walletId,
        closeId: begin.closeId!,
      });
    const result = await t.mutation(internal.wallets.applyDecrease, args);
    expect(result).toMatchObject({
      status: "abandoned",
      gateState: "open",
      epoch: begin.epoch + 1,
      sequence: begin.sequence,
    });
    expect(await t.mutation(internal.wallets.applyDecrease, args)).toEqual(
      result,
    );
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  },
);

it.each([true, false])(
  "books promo source cost with same-org=%s while paid/admin keep 95/5",
  async (sameOrg) => {
    const t = harness(),
      f = await t.run((ctx) => moneyFixture(ctx, "promo-cost", [2], 8));
    await t.run((ctx) => paidLot(ctx, f.walletId, "paid-cost", 3));
    await t.run((ctx) =>
      grantLot(ctx, {
        walletId: f.walletId,
        sourceKind: "promo",
        sourceRef: "signup:cost",
        credits: 3,
      }),
    );
    if (sameOrg) {
      await t.run((ctx) =>
        ctx.db.patch(f.project, { organizationId: f.consumer }),
      );
      f.publisher = f.consumer;
    }
    const event = await t.run((ctx) => eventFor(ctx, f));
    expect((await settle(t, event)).status).toBe("applied");
    const earnings = await t.run((ctx) =>
      ctx.db.query("publisherEarnings").collect(),
    );
    expect(earnings.find((e) => e.sourceRef === "signup:cost")).toMatchObject({
      grossCredits: 3,
      netAtoms: sameOrg ? 0 : 28500,
      platformFeeAtoms: sameOrg ? 0 : 1500,
    });
    expect(earnings.reduce((n, e) => n + e.netAtoms, 0)).toBe(
      (sameOrg ? 5 : 8) * 9500,
    );
    const rollups = await t.run((ctx) =>
      ctx.db.query("usageRollups").collect(),
    );
    expect(
      rollups.find((r) => r.kind === "lifetime" && r.scope === "platform"),
    ).toMatchObject({
      promoCostAtoms: sameOrg ? 30000 : 0,
      netAtoms: (sameOrg ? 5 : 8) * 500,
    });
    await t.run((ctx) => assertWallet(ctx, f.walletId));
  },
);

it("distributes platform and publisher totals over bounded 128-shard scopes", async () => {
  const { shardFor, rollupShardCount, TOTAL_ROLLUP_SHARDS, ROLLUP_SHARDS } =
    await import("../convex/money/rollups");
  expect(TOTAL_ROLLUP_SHARDS).toBeGreaterThanOrEqual(64);
  for (const [scope, dimension, expected] of [
    ["platform", "total", TOTAL_ROLLUP_SHARDS],
    ["publisher", "total", TOTAL_ROLLUP_SHARDS],
    ["publisher", "project", ROLLUP_SHARDS],
    ["consumer", "total", ROLLUP_SHARDS],
  ] as const) {
    const count = rollupShardCount(scope, dimension);
    expect(count).toBe(expected);
    const shards = new Set(
      Array.from({ length: 4096 }, (_, i) =>
        shardFor(`wallet:${i}:settle`, count),
      ),
    );
    expect(shards.size).toBe(count);
    expect(Math.max(...shards)).toBe(count - 1);
  }
});
