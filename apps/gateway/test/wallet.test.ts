import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_USAGE_INGEST_EVENTS } from "@zevium/shared";
import {
  __setTestGrantsFetcher,
  __setTestUsageMutation,
  type WalletDO,
} from "../src/wallet";
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

  it("keeps rejected Convex outcomes pending while applying successful outcomes", async () => {
    const stub = walletStub("unit-partial-convex-outcomes");
    await stub.grant("g1", 100);
    await stub.reserve("r-applied", 10);
    await stub.reserve("r-rejected", 20);
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "org_consumer",
      projectId: "project",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
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
              reason: "temporary ledger rejection",
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

    expect(flushed).toMatchObject({ flushed: 2, acked: 1, remaining: 1 });
    const state = await stub.getState();
    expect(state.sequence).toBe(7);
    expect(state.pendingSettlements).toEqual([
      expect.objectContaining({ settlementId: "settle:r-rejected", cost: 20 }),
    ]);
    // Checkpoint 90 retains the rejected 20 as a conservative local debit.
    expect(state.balance).toBe(70);
  });

  it("dead-letters terminal financial rejects and preserves retryable rejects", async () => {
    const stub = walletStub("unit-terminal-dead-letter");
    __setTestGrantsFetcher(async () => ({
      wallet: {
        clerkOrgId: "unit-terminal-dead-letter",
        balance: 20,
        sequence: 3,
      },
      keySettings: [],
    }));
    await stub.syncGrants("unit-terminal-dead-letter", 100_000);
    __setTestGrantsFetcher(null);
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "unit-terminal-dead-letter",
      projectId: "project",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
    };
    await stub.reserve("r-terminal", 10);
    await stub.reserve("r-retry", 10);
    await stub.settle("r-terminal", usage);
    await stub.settle("r-retry", usage);
    __setTestUsageMutation(async (_name, { events }) => ({
      results: events.map((event) =>
        event.settleRefId === "settle:r-terminal"
          ? {
              refId: event.settleRefId,
              status: "rejected" as const,
              reason: "immutable payload mismatch",
              retryable: false,
            }
          : {
              refId: event.settleRefId,
              status: "rejected" as const,
              reason: "migration pending",
              retryable: true,
            },
      ),
      wallet: {
        clerkOrgId: "unit-terminal-dead-letter",
        balance: 20,
        sequence: 3,
      },
    }));

    expect(await stub.flushToConvex()).toMatchObject({
      flushed: 2,
      acked: 1,
      remaining: 1,
    });
    const state = await stub.getState();
    expect(state.deadLetterCount).toBe(1);
    expect(state.pendingSettlements).toEqual([
      expect.objectContaining({ settlementId: "settle:r-retry" }),
    ]);
    // Same-sequence authoritative response restores exactly the terminal
    // rejection while retaining the retryable settlement's local debit.
    expect(state.balance).toBe(10);
    expect(state.available).toBe(10);
  });

  it("drains more than 500 settlements in server-capped chunks", async () => {
    const stub = walletStub("unit-large-chunking");
    const count = 501;
    await stub.grant("g-large", count);
    const usage = {
      organizationId: "org_publisher",
      consumerClerkOrgId: "unit-large-chunking",
      projectId: "project",
      endpoint: "/endpoint",
      method: "GET",
      status: 200,
      latencyMs: 1,
      keyId: "key",
    };
    for (let index = 0; index < count; index += 1) {
      await stub.reserve(`r-${index}`, 1);
      await stub.settle(`r-${index}`, usage);
    }
    const batchSizes: number[] = [];
    let sequence = 1;
    __setTestUsageMutation(async (_name, { events }) => {
      batchSizes.push(events.length);
      sequence += events.length;
      return {
        results: events.map((event) => ({
          refId: event.settleRefId,
          status: "applied" as const,
        })),
        wallet: {
          clerkOrgId: "unit-large-chunking",
          balance: count - (sequence - 1),
          sequence,
        },
      };
    });

    for (let chunk = 0; chunk < 30; chunk += 1) {
      const result = await stub.flushToConvex();
      if (result.remaining === 0) break;
    }
    const state = await stub.getState();
    expect(state.pendingSettlements).toHaveLength(0);
    expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(count);
    expect(Math.max(...batchSizes)).toBe(MAX_USAGE_INGEST_EVENTS);
    expect(batchSizes).toHaveLength(Math.ceil(count / MAX_USAGE_INGEST_EVENTS));
  });

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
