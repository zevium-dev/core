import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setTestGrantsFetcher,
  __setTestUsageMutation,
  MAX_APPLIED_GRANTS,
  RESERVATION_TTL_MS,
  USAGE_FLUSH_BATCH_SIZE,
  type WalletDO,
} from "../src/wallet";
import { UsageIngestError } from "../src/usage";
import { SimulatedLedger } from "./ledger";

type WalletStub = DurableObjectStub<WalletDO>;

function walletStub(name: string): WalletStub {
  const id = env.WALLET.idFromName(name);
  return env.WALLET.get(id);
}

afterEach(() => {
  __setTestGrantsFetcher(null);
  __setTestUsageMutation(null);
});

/** Seeded mulberry32 PRNG for deterministic fuzz. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("WalletDO unit", () => {
  it("reserve fails at zero balance", async () => {
    const stub = walletStub("unit-zero-balance");
    const state = await stub.getState();
    expect(state.balance).toBe(0);
    expect(state.available).toBe(0);

    const res = await stub.reserve("r1", 1);
    expect(res.status).toBe("insufficient");
    if (res.status === "insufficient") {
      expect(res.available).toBe(0);
      expect(res.cost).toBe(1);
    }
  });

  it("free tier is atomic per consumer project operation and UTC day", async () => {
    const clerkOrgId = "org_free_scope";
    const stub = walletStub(clerkOrgId);
    await stub.grant("free-tier-balance", 1);
    const dayOne = Date.UTC(2026, 6, 19, 23, 59, 59);
    const base = {
      clerkOrgId,
      projectId: "project-a",
      method: "GET",
      pathTemplate: "/widgets/{widgetId}",
      nowMs: dayOne,
    };

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        stub.consumeFreeTier(3, {
          ...base,
          keyId: index % 2 === 0 ? "key-one" : "key-two",
        }),
      ),
    );
    expect(
      concurrent.filter((result) => result.status === "consumed"),
    ).toHaveLength(3);
    expect(
      await stub.getFreeTierUsed({
        clerkOrgId,
        projectId: "project-a",
        method: "GET",
        pathTemplate: "/widgets/{widgetId}",
        nowMs: dayOne,
      }),
    ).toBe(3);

    expect(
      (
        await stub.consumeFreeTier(3, {
          ...base,
          keyId: "key-two",
        })
      ).status,
    ).toBe("exhausted");
    expect(
      (
        await stub.consumeFreeTier(3, {
          ...base,
          keyId: "key-one",
          pathTemplate: "/widgets",
        })
      ).status,
    ).toBe("consumed");
    expect(
      (
        await stub.consumeFreeTier(3, {
          ...base,
          keyId: "key-one",
          projectId: "project-b",
        })
      ).status,
    ).toBe("consumed");
    expect(
      (
        await stub.consumeFreeTier(3, {
          ...base,
          keyId: "key-one",
          nowMs: dayOne + 1_000,
        })
      ).status,
    ).toBe("consumed");
  });

  it("grant idempotency — same grantId does not double-credit", async () => {
    const stub = walletStub("unit-grant-idem");
    const a = await stub.grant("g1", 100);
    expect(a.status).toBe("applied");
    if (a.status === "applied") expect(a.balance).toBe(100);

    const b = await stub.grant("g1", 100);
    expect(b.status).toBe("duplicate");
    if (b.status === "duplicate") expect(b.balance).toBe(100);

    const state = await stub.getState();
    expect(state.balance).toBe(100);
    expect(state.appliedGrantIds).toEqual(["g1"]);
  });

  it("available = balance - inFlight", async () => {
    const stub = walletStub("unit-available");
    await stub.grant("g1", 100);
    await stub.reserve("r1", 30);
    await stub.reserve("r2", 20);

    const state = await stub.getState();
    expect(state.balance).toBe(100);
    expect(state.inFlightTotal).toBe(50);
    expect(state.available).toBe(50);
    expect(state.available).toBe(state.balance - state.inFlightTotal);
  });

  it("reserve conflict same id different cost", async () => {
    const stub = walletStub("unit-reserve-conflict");
    await stub.grant("g1", 100);
    const a = await stub.reserve("r1", 10);
    expect(a.status).toBe("reserved");

    const b = await stub.reserve("r1", 20);
    expect(b.status).toBe("conflict");

    // Same id+cost is idempotent duplicate
    const c = await stub.reserve("r1", 10);
    expect(c.status).toBe("duplicate");

    const state = await stub.getState();
    expect(state.inFlightTotal).toBe(10);
    expect(state.available).toBe(90);
  });

  it("settle/refund idempotency and double-settle no-op", async () => {
    const stub = walletStub("unit-settle-refund");
    await stub.grant("g1", 100);

    await stub.reserve("r-settle", 25);
    const s1 = await stub.settle("r-settle");
    expect(s1.status).toBe("settled");
    if (s1.status === "settled") {
      expect(s1.settlementId).toBe("settle:r-settle");
      expect(s1.balance).toBe(75);
    }

    const s2 = await stub.settle("r-settle");
    expect(s2.status).toBe("already_settled");

    // Refund after settle is a no-op (already settled)
    const rf = await stub.refund("r-settle");
    expect(rf.status).toBe("already_settled");

    await stub.reserve("r-refund", 10);
    const r1 = await stub.refund("r-refund");
    expect(r1.status).toBe("refunded");
    if (r1.status === "refunded") expect(r1.available).toBe(75); // 75 balance, no holds

    const r2 = await stub.refund("r-refund");
    expect(r2.status).toBe("already_refunded");

    // Settle after refund is no-op
    const sAfter = await stub.settle("r-refund");
    expect(sAfter.status).toBe("already_refunded");

    // Unknown id
    expect((await stub.settle("nope")).status).toBe("unknown");
    expect((await stub.refund("nope")).status).toBe("unknown");

    const state = await stub.getState();
    expect(state.balance).toBe(75);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(1);
    expect(state.pendingSettlements[0]!.settlementId).toBe("settle:r-settle");
  });

  it("flush-ack loss recovery — ledger has settlement once; re-flush then ack clears pending", async () => {
    const stub = walletStub("unit-flush-ack-loss");
    const ledger = new SimulatedLedger();

    await ledger.pushGrant(stub, "g1", 50);
    await stub.reserve("r1", 20);
    await stub.settle("r1");

    // First flush, drop ack (simulates lost ack after ledger write)
    const first = await ledger.flushToLedger(stub, { dropAck: true });
    expect(first.flush.settlements).toHaveLength(1);
    expect(first.appended).toHaveLength(1);
    expect(first.acked).toBe(false);
    expect(ledger.settlements).toHaveLength(1);
    expect(ledger.settlementsSum).toBe(20);

    // DO still has pending
    let state = await stub.getState();
    expect(state.pendingSettlements).toHaveLength(1);

    // Re-flush: same settlement id, ledger dedupes
    const second = await ledger.flushToLedger(stub, { dropAck: false });
    expect(second.flush.settlements).toHaveLength(1);
    expect(second.flush.settlements[0]!.settlementId).toBe("settle:r1");
    expect(second.appended).toHaveLength(0); // deduped
    expect(ledger.settlements).toHaveLength(1);
    expect(ledger.settlementsSum).toBe(20);

    state = await stub.getState();
    expect(state.pendingSettlements).toHaveLength(0);
    expect(state.balance).toBe(30);
    expect(ledger.net).toBe(30);
  });

  it("cost must be > 0; zero cost rejected", async () => {
    const stub = walletStub("unit-zero-cost");
    await stub.grant("g1", 10);
    const r = await stub.reserve("r0", 0);
    expect(r.status).toBe("rejected");
    const neg = await stub.reserve("rn", -5);
    expect(neg.status).toBe("rejected");
  });

  it("survives eviction (storage reload)", async () => {
    const stub = walletStub("unit-evict");
    await stub.grant("g1", 80);
    await stub.reserve("r1", 30);
    await stub.settle("r1");

    await evictDurableObject(stub);

    const state = await stub.getState();
    expect(state.balance).toBe(50);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(1);
    expect(state.appliedGrantIds).toContain("g1");
    expect(state.available).toBe(50);

    // Idempotent after reload
    const again = await stub.grant("g1", 80);
    expect(again.status).toBe("duplicate");
    const settleAgain = await stub.settle("r1");
    expect(settleAgain.status).toBe("already_settled");
  });

  it("dead-letters permanent Convex rejections without poisoning later flushes", async () => {
    const stub = walletStub("unit-partial-convex-outcomes");
    await stub.grant("g1", 100);
    await stub.reserve("r-applied", 10);
    await stub.reserve("r-rejected", 20);
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "settled" as const,
      qualityOutcome: "success" as const,
    };
    await stub.settle("r-applied", usage);
    await stub.settle("r-rejected", usage);

    __setTestUsageMutation(async (_name, { events }) => ({
      results: events.map((event) =>
        event.settleRefId === "settle:r-applied"
          ? { refId: event.settleRefId, status: "applied" as const }
          : {
              refId: event.settleRefId,
              status: "rejected" as const,
              reason: "invalid settlement contract",
              retryable: false,
            },
      ),
      wallet: {
        clerkOrgId: "org_consumer",
        balance: 90,
        sequence: 7,
      },
    }));

    const flushed = await stub.flushToConvex();
    __setTestUsageMutation(null);

    expect(flushed).toMatchObject({
      flushed: 2,
      acked: 1,
      rejected: 1,
      retryable: 0,
      remaining: 0,
    });
    const state = await stub.getState();
    expect(state.sequence).toBe(7);
    expect(state.pendingSettlements).toEqual([]);
    // Authoritative checkpoint did not debit rejected row, so spendable balance
    // recovers while durable dead-letter evidence remains for operators.
    expect(state.balance).toBe(90);
    await expect(
      stub.getSettlementDeadLetter("settle:r-rejected"),
    ).resolves.toMatchObject({
      reason: "invalid settlement contract",
      terminal: true,
      source: "outcome",
    });
    await expect(stub.flushToConvex()).resolves.toMatchObject({ flushed: 0 });
  });

  it("expires abandoned reservations past the lease and keeps late settle idempotent", async () => {
    const stub = walletStub("unit-lease-expiry");
    const t0 = 1_700_000_000_000;
    await stub.grant("g1", 100);
    await stub.reserve("r-orphan", 40, { nowMs: t0 });
    expect((await stub.getState()).available).toBe(60);

    // Next reserve past the lease sweeps the orphaned hold.
    await stub.reserve("r-next", 10, { nowMs: t0 + RESERVATION_TTL_MS + 1 });
    const state = await stub.getState();
    expect(state.inFlight["r-orphan"]).toBeUndefined();
    expect(state.available).toBe(90);

    // Late settle/refund on the expired reservation stay idempotent.
    await expect(stub.settle("r-orphan")).resolves.toMatchObject({
      status: "already_refunded",
    });
    await expect(stub.refund("r-orphan")).resolves.toMatchObject({
      status: "already_refunded",
    });
  });

  it("serves stale key settings while refreshing in the background", async () => {
    const clerkOrgId = "org_stale_settings";
    const stub = walletStub(clerkOrgId);
    await stub.grant("g1", 100);
    let fetches = 0;
    __setTestGrantsFetcher(async () => {
      fetches += 1;
      return {
        wallet: { clerkOrgId, balance: 100, sequence: 1 },
        keySettings: [{ keyId: "key_a", disabled: false }],
      };
    });

    const t0 = 1_700_000_000_000;
    // First contact blocks and syncs.
    await stub.reserve("r1", 5, { keyId: "key_a", clerkOrgId, nowMs: t0 });
    expect(fetches).toBe(1);

    // Stale window crossed: refresh runs in the background and a failing
    // control plane does not reject or hang the reserve path.
    __setTestGrantsFetcher(async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("convex down");
    });
    const res = await stub.reserve("r2", 5, {
      keyId: "key_a",
      clerkOrgId,
      nowMs: t0 + 61_000,
    });
    expect(res.status).toBe("reserved");
    // Background refresh was scheduled (test harness settles waitUntil).
    expect(fetches).toBe(2);
    // Failed refresh leaves the last-known settings and wallet intact.
    const state = await stub.getState();
    expect(state.balance).toBe(100);
    expect(state.available).toBe(90);
  });

  it("bounds the applied-grant dedupe set", async () => {
    const stub = walletStub("unit-grant-cap");
    for (let index = 0; index < MAX_APPLIED_GRANTS + 5; index += 1) {
      await stub.grant(`g${index}`, 1);
    }
    const state = await stub.getState();
    expect(state.appliedGrantIds.length).toBe(MAX_APPLIED_GRANTS);
    expect(state.balance).toBe(MAX_APPLIED_GRANTS + 5);
    // Oldest evicted: replaying g0 is applied again by the DO; the Convex
    // ledger remains the authoritative dedupe beyond the DO window.
    const replay = await stub.grant("g0", 1);
    expect(replay.status).toBe("applied");
  });

  it("restores paid credit when a permanent rejection keeps the same checkpoint", async () => {
    const stub = walletStub("unit-permanent-rejection-stale-checkpoint");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "settled" as const,
      qualityOutcome: "success" as const,
    };
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: "org_consumer", balance: 100, sequence: 7 },
      keySettings: [],
    }));
    await stub.syncGrants("org_consumer", 100_000);
    __setTestGrantsFetcher(null);
    await stub.reserve("permanent", 20);
    await stub.settle("permanent", usage);
    __setTestUsageMutation(async (_name, { events }) => ({
      results: events.map((event) => ({
        refId: event.settleRefId,
        status: "rejected" as const,
        reason: "permanent contract rejection",
        retryable: false,
      })),
      wallet: { clerkOrgId: "org_consumer", balance: 100, sequence: 7 },
    }));

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      acked: 0,
      rejected: 1,
      remaining: 0,
    });
    await expect(stub.getState()).resolves.toMatchObject({
      balance: 100,
      sequence: 7,
      pendingSettlements: [],
    });
  });

  it("reconciles crash, checkpoint sync, and already-applied replay exactly", async () => {
    const stub = walletStub("unit-crash-sync-already-applied");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "settled" as const,
      qualityOutcome: "success" as const,
    };
    await stub.grant("crash-grant", 100);
    await stub.reserve("crash-paid", 10);
    await stub.settle("crash-paid", usage);
    __setTestUsageMutation(async () => {
      throw new UsageIngestError("ack lost after commit", true);
    });
    await expect(stub.flushToConvex()).resolves.toMatchObject({
      retryable: 1,
      remaining: 1,
    });

    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: "org_consumer", balance: 90, sequence: 1 },
      keySettings: [],
    }));
    await stub.syncGrants("org_consumer", 100_000);
    __setTestGrantsFetcher(null);
    await evictDurableObject(stub);
    await expect(stub.getState()).resolves.toMatchObject({
      balance: 80,
      sequence: 1,
      pendingSettlements: [
        expect.objectContaining({ settlementId: "settle:crash-paid" }),
      ],
    });

    __setTestUsageMutation(async (_name, { events }) => ({
      results: events.map((event) => ({
        refId: event.settleRefId,
        status: "already_applied" as const,
      })),
      wallet: { clerkOrgId: "org_consumer", balance: 90, sequence: 1 },
    }));
    await expect(stub.flushToConvex()).resolves.toMatchObject({
      acked: 1,
      remaining: 0,
    });
    await expect(stub.getState()).resolves.toMatchObject({
      balance: 90,
      sequence: 1,
      pendingSettlements: [],
    });
  });

  it("drains more than one ingest limit in bounded recoverable batches", async () => {
    const stub = walletStub("unit-bounded-convex-batches");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "free" as const,
      qualityOutcome: "success" as const,
    };
    for (let index = 0; index <= USAGE_FLUSH_BATCH_SIZE; index += 1) {
      await stub.enqueueFreeUsage(`free-${index}`, usage);
    }
    const batches: number[] = [];
    let sequence = 0;
    __setTestUsageMutation(async (_name, { events }) => {
      batches.push(events.length);
      sequence += 1;
      return {
        results: events.map((event) => ({
          refId: event.settleRefId,
          status: "applied" as const,
        })),
        wallet: {
          clerkOrgId: "org_consumer",
          balance: 0,
          sequence,
        },
      };
    });

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: USAGE_FLUSH_BATCH_SIZE,
      acked: USAGE_FLUSH_BATCH_SIZE,
      remaining: 1,
    });
    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 1,
      acked: 1,
      remaining: 0,
    });
    expect(batches).toEqual([USAGE_FLUSH_BATCH_SIZE, 1]);
  });

  it("rotates explicitly retryable rows while acknowledging later outcomes", async () => {
    const stub = walletStub("unit-retryable-row-rotation");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "free" as const,
      qualityOutcome: "success" as const,
    };
    for (const id of ["retry", "later-one", "later-two"]) {
      await stub.enqueueFreeUsage(id, usage);
    }
    const batches: string[][] = [];
    let attempt = 0;
    __setTestUsageMutation(async (_name, { events }) => {
      attempt += 1;
      batches.push(events.map((event) => event.settleRefId));
      return {
        results: events.map((event) =>
          attempt === 1 && event.settleRefId === "settle:retry"
            ? {
                refId: event.settleRefId,
                status: "rejected" as const,
                reason: "grant projection lag",
                retryable: true,
              }
            : { refId: event.settleRefId, status: "applied" as const },
        ),
        wallet: {
          clerkOrgId: "org_consumer",
          balance: 0,
          sequence: attempt,
        },
      };
    });

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 3,
      acked: 2,
      rejected: 0,
      retryable: 1,
      remaining: 1,
    });
    await expect(stub.getState()).resolves.toMatchObject({
      pendingSettlements: [
        expect.objectContaining({ settlementId: "settle:retry" }),
      ],
    });
    await expect(
      stub.getSettlementDeadLetter("settle:retry"),
    ).resolves.toBeNull();

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 1,
      acked: 1,
      retryable: 0,
      remaining: 0,
    });
    expect(batches).toEqual([
      ["settle:retry", "settle:later-one", "settle:later-two"],
      ["settle:retry"],
    ]);
  });

  it("recursively bisects a permanent batch poison and dead-letters only its singleton", async () => {
    const stub = walletStub("unit-recursive-poison-bisection");
    await stub.grant("poison-test-grant", 90);
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "settled" as const,
      qualityOutcome: "success" as const,
    };
    for (let index = 0; index < 9; index += 1) {
      const reservationId = index === 8 ? "poison" : `good-${index}`;
      await expect(stub.reserve(reservationId, 1)).resolves.toMatchObject({
        status: "reserved",
      });
      await expect(stub.settle(reservationId, usage)).resolves.toMatchObject({
        status: "settled",
      });
    }
    const batchSizes: number[] = [];
    let sequence = 0;
    let authoritativeBalance = 90;
    __setTestUsageMutation(async (_name, { events }) => {
      batchSizes.push(events.length);
      if (events.some((event) => event.settleRefId === "settle:poison")) {
        throw new UsageIngestError("deterministic poison", false, {
          bisectable: true,
        });
      }
      sequence += events.length;
      authoritativeBalance -= events.reduce(
        (total, event) => total + event.credits,
        0,
      );
      return {
        results: events.map((event) => ({
          refId: event.settleRefId,
          status: "applied" as const,
        })),
        wallet: {
          clerkOrgId: "org_consumer",
          balance: authoritativeBalance,
          sequence,
        },
      };
    });

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 9,
      acked: 8,
      rejected: 1,
      retryable: 0,
      remaining: 0,
    });
    expect(batchSizes).toEqual([9, 4, 5, 2, 3, 1, 2, 1, 1]);
    await expect(stub.getState()).resolves.toMatchObject({
      balance: 82,
      pendingSettlements: [],
    });
    await expect(
      stub.getSettlementDeadLetter("settle:poison"),
    ).resolves.toMatchObject({
      reason: "deterministic poison",
      terminal: true,
      source: "batch",
      settlement: { settlementId: "settle:poison" },
    });
    for (let index = 0; index < 8; index += 1) {
      await expect(
        stub.getSettlementDeadLetter(`settle:good-${index}`),
      ).resolves.toBeNull();
    }
  });

  it("keeps systemic permanent failures intact instead of mass dead-lettering", async () => {
    const stub = walletStub("unit-systemic-protocol-failure");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "free" as const,
      qualityOutcome: "success" as const,
    };
    for (const id of ["one", "two", "three"]) {
      await stub.enqueueFreeUsage(id, usage);
    }
    let calls = 0;
    __setTestUsageMutation(async () => {
      calls += 1;
      throw new UsageIngestError("server contract mismatch", false);
    });

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 0,
      acked: 0,
      rejected: 0,
      retryable: 0,
      blocked: 3,
      remaining: 3,
      error: "server contract mismatch",
    });
    expect(calls).toBe(1);
    expect((await stub.getState()).pendingSettlements).toHaveLength(3);
    for (const id of ["one", "two", "three"]) {
      await expect(
        stub.getSettlementDeadLetter(`settle:${id}`),
      ).resolves.toBeNull();
    }
  });

  it("persists over 1000 rows in bounded partitions across restart and ambiguous crash", async () => {
    const stub = walletStub("unit-durable-partitions-over-1000");
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      specVersionId: "version",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
      billingOutcome: "free" as const,
      qualityOutcome: "success" as const,
    };
    const rowCount = 1_037;
    for (let index = 0; index < rowCount; index += 1) {
      await stub.enqueueFreeUsage(`bulk-${index}`, usage);
    }
    const expectedSizes = [
      ...Array.from(
        { length: Math.floor(rowCount / USAGE_FLUSH_BATCH_SIZE) },
        () => USAGE_FLUSH_BATCH_SIZE,
      ),
      rowCount % USAGE_FLUSH_BATCH_SIZE,
    ];
    await expect(stub.getSettlementQueueLayout()).resolves.toEqual({
      size: rowCount,
      partitionCount: expectedSizes.length,
      partitionSizes: expectedSizes,
    });

    await evictDurableObject(stub);
    await expect(stub.getState()).resolves.toMatchObject({
      pendingSettlements: expect.any(Array),
    });
    expect((await stub.getState()).pendingSettlements).toHaveLength(rowCount);

    const committed = new Set<string>();
    const batchSizes: number[] = [];
    let dropAfterCommit = true;
    let sequence = 0;
    __setTestUsageMutation(async (_name, { events }) => {
      batchSizes.push(events.length);
      if (dropAfterCommit) {
        dropAfterCommit = false;
        for (const event of events) committed.add(event.settleRefId);
        sequence += events.length;
        throw new UsageIngestError("connection lost after commit", true);
      }
      const results = events.map((event) => {
        if (committed.has(event.settleRefId)) {
          return {
            refId: event.settleRefId,
            status: "already_applied" as const,
          };
        }
        committed.add(event.settleRefId);
        sequence += 1;
        return { refId: event.settleRefId, status: "applied" as const };
      });
      return {
        results,
        wallet: {
          clerkOrgId: "org_consumer",
          balance: 0,
          sequence,
        },
      };
    });

    await expect(stub.flushToConvex()).resolves.toMatchObject({
      flushed: 0,
      acked: 0,
      retryable: USAGE_FLUSH_BATCH_SIZE,
      remaining: rowCount,
      error: "connection lost after commit",
    });
    await evictDurableObject(stub);
    expect((await stub.getState()).pendingSettlements).toHaveLength(rowCount);

    while ((await stub.getState()).pendingSettlements.length > 0) {
      await expect(stub.flushToConvex()).resolves.not.toHaveProperty("error");
    }
    expect(committed.size).toBe(rowCount);
    expect(batchSizes.every((size) => size <= USAGE_FLUSH_BATCH_SIZE)).toBe(
      true,
    );
    expect(batchSizes).toHaveLength(
      1 + Math.ceil(rowCount / USAGE_FLUSH_BATCH_SIZE),
    );
    await expect(stub.getSettlementQueueLayout()).resolves.toEqual({
      size: 0,
      partitionCount: 0,
      partitionSizes: [],
    });
  }, 120_000);

  it("reconciles a newer checkpoint without discarding holds or pending settlement", async () => {
    const stub = walletStub("unit-checkpoint-preserves-local-state");
    let checkpoint = { clerkOrgId: "org_reconcile", balance: 100, sequence: 1 };
    __setTestGrantsFetcher(async () => ({
      wallet: checkpoint,
      keySettings: [],
    }));

    await stub.syncGrants("org_reconcile", 100_000);
    await stub.reserve("r-held", 30);
    await stub.reserve("r-pending", 20);
    await stub.settle("r-pending");

    checkpoint = { clerkOrgId: "org_reconcile", balance: 100, sequence: 2 };
    await stub.syncGrants("org_reconcile", 161_000);
    __setTestGrantsFetcher(null);

    const state = await stub.getState();
    expect(state.sequence).toBe(2);
    expect(state.balance).toBe(80);
    expect(state.inFlight).toMatchObject({ "r-held": { cost: 30 } });
    expect(state.pendingSettlements).toEqual([
      expect.objectContaining({ settlementId: "settle:r-pending", cost: 20 }),
    ]);
    expect(state.available).toBe(50);
  });

  it("clamps a negative authoritative checkpoint to zero spendable credit", async () => {
    const stub = walletStub("unit-negative-checkpoint");
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: "org_negative", balance: -25, sequence: 1 },
      keySettings: [],
    }));

    await stub.syncGrants("org_negative", 100_000);
    __setTestGrantsFetcher(null);

    const state = await stub.getState();
    expect(state.balance).toBe(-25);
    expect(state.available).toBe(0);
    await expect(stub.reserve("r1", 1)).resolves.toEqual({
      status: "insufficient",
      available: 0,
      cost: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Property / fuzz test
// ---------------------------------------------------------------------------

describe("WalletDO property/fuzz", () => {
  it("200 random ops preserve non-negative balance and ledger invariant at quiescence", async () => {
    const seed = 0xc0ffee;
    const rng = mulberry32(seed);
    const stub = walletStub(`fuzz-${seed}`);
    const ledger = new SimulatedLedger();

    type OpenRes = { id: string; cost: number };
    const open: OpenRes[] = [];
    let grantSeq = 0;
    let resSeq = 0;

    const assertNonNegative = async (label: string) => {
      const state = await stub.getState();
      expect(state.balance, `${label}: balance >= 0`).toBeGreaterThanOrEqual(0);
      expect(
        state.available,
        `${label}: available >= 0`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        state.inFlightTotal,
        `${label}: inFlightTotal >= 0`,
      ).toBeGreaterThanOrEqual(0);
      // available === balance - inFlightTotal
      expect(state.available).toBe(state.balance - state.inFlightTotal);
    };

    const OPS = 200;
    for (let i = 0; i < OPS; i++) {
      const roll = rng();

      if (roll < 0.22) {
        // grant
        grantSeq += 1;
        const amount = pickInt(rng, 1, 100);
        await ledger.pushGrant(stub, `g-${grantSeq}`, amount);
      } else if (roll < 0.5) {
        // reserve — try random cost; may fail on insufficient
        resSeq += 1;
        const cost = pickInt(rng, 1, 40);
        const id = `r-${resSeq}`;
        const result = await stub.reserve(id, cost);
        if (result.status === "reserved") {
          open.push({ id, cost });
        }
      } else if (roll < 0.68) {
        // settle a random open reservation
        if (open.length > 0) {
          const idx = pickInt(rng, 0, open.length - 1);
          const [item] = open.splice(idx, 1);
          await stub.settle(item!.id);
        }
      } else if (roll < 0.82) {
        // refund a random open reservation
        if (open.length > 0) {
          const idx = pickInt(rng, 0, open.length - 1);
          const [item] = open.splice(idx, 1);
          await stub.refund(item!.id);
        }
      } else if (roll < 0.93) {
        // flush, ~30% drop ack
        const dropAck = rng() < 0.3;
        await ledger.flushToLedger(stub, { dropAck });
      } else {
        // simulated DO restart
        await evictDurableObject(stub);
      }

      await assertNonNegative(`op ${i}`);
    }

    // Quiescence: close all open reservations (mix settle/refund), drain flush
    while (open.length > 0) {
      const item = open.pop()!;
      if (rng() < 0.5) {
        await stub.settle(item.id);
      } else {
        await stub.refund(item.id);
      }
      await assertNonNegative("quiesce-close");
    }

    await ledger.drain(stub);
    await assertNonNegative("post-drain");

    const state = await stub.getState();
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(0);
    expect(Object.keys(state.inFlight)).toHaveLength(0);

    // Invariant: ledgerGrantsSum - ledgerSettledSum === doBalance (+ inFlightSum, which is 0)
    expect(ledger.net).toBe(state.balance + state.inFlightTotal);
    expect(ledger.net).toBe(state.balance);

    // Sanity: no negative anywhere
    expect(state.balance).toBeGreaterThanOrEqual(0);
    expect(ledger.grantsSum).toBeGreaterThanOrEqual(ledger.settlementsSum);
  });

  it("second seed run also holds invariant", async () => {
    const seed = 42;
    const rng = mulberry32(seed);
    const stub = walletStub(`fuzz-${seed}`);
    const ledger = new SimulatedLedger();
    const open: { id: string; cost: number }[] = [];
    let grantSeq = 0;
    let resSeq = 0;

    for (let i = 0; i < 150; i++) {
      const roll = rng();
      if (roll < 0.25) {
        grantSeq += 1;
        await ledger.pushGrant(stub, `g-${grantSeq}`, pickInt(rng, 1, 100));
      } else if (roll < 0.55) {
        resSeq += 1;
        const cost = pickInt(rng, 1, 50);
        const id = `r-${resSeq}`;
        if ((await stub.reserve(id, cost)).status === "reserved") {
          open.push({ id, cost });
        }
      } else if (roll < 0.7 && open.length) {
        const idx = pickInt(rng, 0, open.length - 1);
        const [item] = open.splice(idx, 1);
        await stub.settle(item!.id);
      } else if (roll < 0.82 && open.length) {
        const idx = pickInt(rng, 0, open.length - 1);
        const [item] = open.splice(idx, 1);
        await stub.refund(item!.id);
      } else if (roll < 0.92) {
        await ledger.flushToLedger(stub, { dropAck: rng() < 0.3 });
      } else {
        await evictDurableObject(stub);
      }

      const st = await stub.getState();
      expect(st.balance).toBeGreaterThanOrEqual(0);
      expect(st.available).toBeGreaterThanOrEqual(0);
    }

    while (open.length) {
      const item = open.pop()!;
      await stub.settle(item.id);
    }
    await ledger.drain(stub);

    const state = await stub.getState();
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(0);
    expect(ledger.net).toBe(state.balance);
  });
});
