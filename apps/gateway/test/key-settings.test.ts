import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setTestGrantsFetcher,
  type KeySetting,
  type WalletDO,
} from "../src/wallet";

type WalletStub = DurableObjectStub<WalletDO>;

function walletStub(name: string): WalletStub {
  const id = env.WALLET.idFromName(name);
  return env.WALLET.get(id);
}

const ORG = "org_test";

/** Seed a DO via the test grants fetcher: grants + key settings, then sync. */
async function seed(
  stub: WalletStub,
  opts: {
    grants?: { refId: string; amount: number }[];
    keySettings?: KeySetting[];
    balance?: number;
    archived?: boolean;
  },
): Promise<void> {
  __setTestGrantsFetcher(async () => ({
    wallet: {
      clerkOrgId: ORG,
      balance:
        opts.balance ??
        (opts.grants ?? []).reduce((total, grant) => total + grant.amount, 0),
      sequence: 0,
    },
    keySettings: opts.keySettings ?? [],
    archived: opts.archived ?? false,
  }));
  await stub.syncGrants(ORG);
  __setTestGrantsFetcher(null);
}

describe("WalletDO key controls — reserve enforcement", () => {
  beforeEach(() => {
    __setTestGrantsFetcher(null);
  });
  afterEach(() => {
    __setTestGrantsFetcher(null);
  });

  it("rejects a disabled key with key_disabled", async () => {
    const stub = walletStub("key-disabled");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [{ keyId: "k1", keyFamilyId: "family-1", disabled: true }],
    });

    const res = await stub.reserve("r1", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(res).toEqual({ status: "rejected", reason: "key_disabled" });
  });

  it("denies rotation-required keys even if disabled bit is stale", async () => {
    const stub = walletStub("key-rotation-required");
    await seed(stub, {
      balance: 1_000,
      keySettings: [
        { keyId: "k1", disabled: false, rotationRequiredAt: Date.now() },
      ],
    });

    await expect(stub.authorizeKey("k1", ORG)).resolves.toEqual({
      status: "rejected",
      reason: "key_disabled",
    });
  });

  it("terminally denies every admission after control-plane org archive", async () => {
    const stub = walletStub("organization-archived");
    await seed(stub, {
      balance: 1_000,
      keySettings: [{ keyId: "k1", disabled: false }],
      archived: true,
    });

    await expect(stub.authorizeKey("k1", ORG)).resolves.toEqual({
      status: "rejected",
      reason: "organization_archived",
    });
    await expect(
      stub.reserve("archived-r1", 1, { keyId: "k1", clerkOrgId: ORG }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "organization_archived",
    });
    await expect(
      stub.consumeFreeTier(1, {
        keyId: "k1",
        clerkOrgId: ORG,
        projectId: "project_1",
        method: "GET",
        pathTemplate: "/ping",
      }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "organization_archived",
    });

    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: ORG, balance: 1_000, sequence: 1 },
      keySettings: [{ keyId: "k1", disabled: false }],
      archived: false,
    }));
    await stub.syncGrants(ORG, Date.now() + 61_000);
    __setTestGrantsFetcher(null);
    await expect(
      stub.authorizeKey("k1", ORG, Date.now() + 61_001),
    ).resolves.toMatchObject({ reason: "organization_archived" });
  });

  it("rejects when monthly settled credits reach the cap (boundary)", async () => {
    const stub = walletStub("key-cap");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [
        {
          keyId: "k1",
          keyFamilyId: "family-1",
          disabled: false,
          monthlyCapCredits: 100,
        },
        { keyId: "k_other", keyFamilyId: "family-other", disabled: false },
      ],
    });

    // First reserve+settle of 100 consumes exactly the cap.
    const r1 = await stub.reserve("r1", 100, { keyId: "k1", clerkOrgId: ORG });
    expect(r1.status).toBe("reserved");
    await stub.settle("r1", {
      organizationId: "orgs/x",
      projectId: "projects/y",
      endpoint: "/e",
      method: "GET",
      status: 200,
      latencyMs: 5,
      keyId: "k1",
    });

    // Next reserve for the same key trips the cap (used 100 >= cap 100).
    const r2 = await stub.reserve("r2", 1, { keyId: "k1", clerkOrgId: ORG });
    expect(r2).toEqual({ status: "rejected", reason: "key_cap_exceeded" });

    // A tracked key without a cap is unaffected.
    const r3 = await stub.reserve("r3", 1, {
      keyId: "k_other",
      clerkOrgId: ORG,
    });
    expect(r3.status).toBe("reserved");
  });

  it("charges settlement to immutable reservation month across month rollover", async () => {
    const stub = walletStub("key-cap-reservation-month");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [{ keyId: "k1", disabled: false, monthlyCapCredits: 100 }],
    });
    const january = Date.UTC(2026, 0, 31, 23, 59, 59);
    expect(
      (
        await stub.reserve("r-january", 100, {
          keyId: "k1",
          clerkOrgId: ORG,
          nowMs: january,
        })
      ).status,
    ).toBe("reserved");
    await stub.settle("r-january", {
      organizationId: "orgs/publisher",
      projectId: "projects/api",
      endpoint: "/v1/work",
      method: "POST",
      status: 200,
      latencyMs: 1,
      keyId: "untrusted-overwritten-key",
    });

    expect(
      await stub.reserve("r-january-over-cap", 1, {
        keyId: "k1",
        clerkOrgId: ORG,
        nowMs: january,
      }),
    ).toEqual({ status: "rejected", reason: "key_cap_exceeded" });
  });

  it("counts active reservations plus requested cost at the cap boundary", async () => {
    const stub = walletStub("key-cap-concurrent");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [
        {
          keyId: "k1",
          keyFamilyId: "family-1",
          disabled: false,
          monthlyCapCredits: 100,
        },
      ],
    });

    const results = await Promise.all([
      stub.reserve("r1", 60, { keyId: "k1", clerkOrgId: ORG }),
      stub.reserve("r2", 60, { keyId: "k1", clerkOrgId: ORG }),
    ]);

    expect(
      results.filter((result) => result.status === "reserved"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: "key_cap_exceeded" },
    ]);
    const state = await stub.getState();
    expect(state.inFlightTotal).toBe(60);
  });

  it("keeps settled and reserved cap usage continuous across rotation", async () => {
    const stub = walletStub("key-cap-family-rotation");
    const settings: KeySetting[] = [
      {
        keyId: "k_old",
        keyFamilyId: "family-stable",
        disabled: false,
        monthlyCapCredits: 100,
        graceUntil: Date.now() + 60_000,
      },
      {
        keyId: "k_new",
        keyFamilyId: "family-stable",
        disabled: false,
        monthlyCapCredits: 100,
        rotatedFromKeyId: "k_old",
      },
    ];
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: settings,
    });
    expect(
      await stub.reserve("old-settled", 60, {
        keyId: "k_old",
        clerkOrgId: ORG,
      }),
    ).toMatchObject({ status: "reserved" });
    await stub.settle("old-settled");

    const concurrent = await Promise.all([
      stub.reserve("new-a", 25, { keyId: "k_new", clerkOrgId: ORG }),
      stub.reserve("new-b", 25, { keyId: "k_new", clerkOrgId: ORG }),
    ]);
    expect(
      concurrent.filter((result) => result.status === "reserved"),
    ).toHaveLength(1);
    expect(concurrent).toContainEqual({
      status: "rejected",
      reason: "key_cap_exceeded",
    });
  });

  it("allows a rotated (grace) key before graceUntil, rejects after", async () => {
    const stub = walletStub("key-grace");
    const now = 1_000_000;
    const grace = now + 60_000;
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [
        {
          keyId: "k_old",
          keyFamilyId: "family-1",
          disabled: false,
          graceUntil: grace,
        },
      ],
    });

    // Within grace: allowed.
    const within = await stub.reserve("r1", 5, {
      keyId: "k_old",
      clerkOrgId: ORG,
      nowMs: now + 10_000,
    });
    expect(within.status).toBe("reserved");

    // After grace: treated as disabled.
    const after = await stub.reserve("r2", 5, {
      keyId: "k_old",
      clerkOrgId: ORG,
      nowMs: grace + 1,
    });
    expect(after).toEqual({ status: "rejected", reason: "key_disabled" });
  });

  it("fails closed when a verified key has no control-plane row", async () => {
    const stub = walletStub("key-none");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [],
    });
    const res = await stub.reserve("r1", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(res).toEqual({ status: "rejected", reason: "key_untracked" });
  });

  it("reserve without opts skips key enforcement (back-compat)", async () => {
    const stub = walletStub("key-nocall");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [{ keyId: "k1", keyFamilyId: "family-1", disabled: true }],
    });
    const res = await stub.reserve("r1", 10);
    expect(res.status).toBe("reserved");
  });
});

describe("WalletDO key controls — lazy single-flight refresh", () => {
  beforeEach(() => {
    __setTestGrantsFetcher(null);
  });
  afterEach(() => {
    __setTestGrantsFetcher(null);
  });

  it("unknown key triggers a single refresh, not one per request", async () => {
    const stub = walletStub("key-lazy");
    let fetchCount = 0;

    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1000, sequence: 0 },
        keySettings: [{ keyId: "k1", keyFamilyId: "family-1", disabled: true }],
      };
    });

    // First reserve: unknown key + never synced → one fetch, then reject.
    const r1 = await stub.reserve("r1", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(r1).toEqual({ status: "rejected", reason: "key_disabled" });
    expect(fetchCount).toBe(1);

    // Second reserve: key now cached → no new fetch.
    const r2 = await stub.reserve("r2", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(r2).toEqual({ status: "rejected", reason: "key_disabled" });
    expect(fetchCount).toBe(1);
  });

  it("does not refresh when sync is fresh (<60s) even for an unknown key", async () => {
    const stub = walletStub("key-fresh");
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1000, sequence: 0 },
        keySettings: [],
      };
    });
    // Prime the sync window (and balance) so a later lazy refresh is skipped.
    await stub.syncGrants(ORG);
    const primedFetches = fetchCount;

    // Unknown key but fresh sync → no refresh and fail closed.
    const res = await stub.reserve("r1", 5, {
      keyId: "unknown",
      clerkOrgId: ORG,
    });
    expect(res).toEqual({ status: "rejected", reason: "key_untracked" });
    expect(fetchCount).toBe(primedFetches);
  });

  it("serves cached controls and finalizes calls while refresh is blocked on network", async () => {
    const stub = walletStub("key-stale-known");
    await seed(stub, {
      balance: 1_000,
      keySettings: [{ keyId: "k1", disabled: false, monthlyCapCredits: 10 }],
    });
    await runInDurableObject(stub, async (wallet) => {
      await wallet.reserve("held", 5, { keyId: "k1", clerkOrgId: ORG });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const fetching = new Promise<void>((resolve) => {
        started = resolve;
      });
      let fetchCount = 0;
      __setTestGrantsFetcher(async () => {
        fetchCount += 1;
        started();
        await gate;
        return {
          wallet: { clerkOrgId: ORG, balance: 1_000, sequence: 1 },
          keySettings: [{ keyId: "k1", disabled: true }],
        };
      });
      const nowMs = Date.now() + 61_000;
      const admission = wallet.reserve("stale", 5, {
        keyId: "k1",
        clerkOrgId: ORG,
        nowMs,
      });
      try {
        await fetching;
        await expect(admission).resolves.toMatchObject({ status: "reserved" });
        await expect(
          wallet.reserve("over-cap", 1, {
            keyId: "k1",
            clerkOrgId: ORG,
            nowMs,
          }),
        ).resolves.toMatchObject({ reason: "key_cap_exceeded" });
        await expect(
          wallet.authorizeKey("k1", ORG, nowMs),
        ).resolves.toMatchObject({
          status: "allowed",
        });
        await expect(wallet.settle("held")).resolves.toMatchObject({
          status: "settled",
        });
        await expect(wallet.refund("stale")).resolves.toMatchObject({
          status: "refunded",
        });
        expect(fetchCount).toBe(1);
      } finally {
        release();
        await wallet.syncGrants(ORG, nowMs);
      }
      await expect(
        wallet.authorizeKey("k1", ORG, nowMs),
      ).resolves.toMatchObject({
        reason: "key_disabled",
      });
      // Refresh checkpoint subtracts the settlement created during network wait.
      expect((await wallet.getState()).balance).toBe(995);
    });
  });

  it("retains last-known controls through refresh failure and eviction", async () => {
    const stub = walletStub("key-stale-refresh-failure");
    await seed(stub, {
      balance: 1_000,
      keySettings: [{ keyId: "k1", disabled: false }],
    });
    __setTestGrantsFetcher(async () => {
      throw new Error("Convex unavailable");
    });
    const nowMs = Date.now() + 61_000;
    await expect(
      stub.reserve("r1", 5, { keyId: "k1", clerkOrgId: ORG, nowMs }),
    ).resolves.toMatchObject({ status: "reserved" });
    await stub.syncGrants(ORG, nowMs);
    await evictDurableObject(stub);
    await expect(
      stub.authorizeKey("k1", ORG, nowMs + 1),
    ).resolves.toMatchObject({ status: "allowed" });
    await expect(
      stub.authorizeKey("missing", ORG, nowMs + 1),
    ).resolves.toMatchObject({ reason: "key_untracked" });
  });

  it("returns unavailable without a snapshot and recovers after a short retry window", async () => {
    const stub = walletStub("key-cold-refresh-failure");
    const nowMs = Date.now();
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return null;
    });
    await expect(
      stub.reserve("cold", 1, { keyId: "k1", clerkOrgId: ORG, nowMs }),
    ).resolves.toMatchObject({ reason: "wallet_unavailable" });
    await expect(
      stub.authorizeKey("k1", ORG, nowMs + 1),
    ).resolves.toMatchObject({ reason: "wallet_unavailable" });
    await expect(
      stub.consumeFreeTier(1, {
        keyId: "k1",
        clerkOrgId: ORG,
        projectId: "p",
        method: "GET",
        pathTemplate: "/",
        nowMs: nowMs + 1,
      }),
    ).resolves.toMatchObject({ reason: "wallet_unavailable" });
    expect(fetchCount).toBe(1);
    await evictDurableObject(stub);
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: ORG, balance: 10, sequence: 0 },
      keySettings: [{ keyId: "k1", disabled: false }],
    }));
    await expect(
      stub.reserve("recovered", 1, {
        keyId: "k1",
        clerkOrgId: ORG,
        nowMs: nowMs + 5_001,
      }),
    ).resolves.toMatchObject({ status: "reserved" });
  });

  it("concurrent unknown-key reserves share a single fetch (single-flight)", async () => {
    const stub = walletStub("key-concurrent");
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1000, sequence: 0 },
        keySettings: [
          { keyId: "k_shared", keyFamilyId: "family-1", disabled: true },
        ],
      };
    });

    const results = await Promise.all([
      stub.reserve("c1", 10, { keyId: "k_shared", clerkOrgId: ORG }),
      stub.reserve("c2", 10, { keyId: "k_shared", clerkOrgId: ORG }),
      stub.reserve("c3", 10, { keyId: "k_shared", clerkOrgId: ORG }),
    ]);

    for (const r of results) {
      expect(r).toEqual({ status: "rejected", reason: "key_disabled" });
    }
    expect(fetchCount).toBe(1);
  });
});

describe("per-key request bucket", () => {
  it("persists across eviction, refills, isolates keys and makes no control-plane calls", async () => {
    const stub = walletStub("rate-bucket");
    await seed(stub, {
      balance: 1000,
      keySettings: [
        { keyId: "k1", disabled: false },
        { keyId: "k2", disabled: false },
      ],
    });
    let networkCalls = 0;
    __setTestGrantsFetcher(async () => {
      networkCalls++;
      throw new Error("network must not run");
    });
    const now = Date.now();
    const burst = await Promise.all(
      Array.from({ length: 60 }, () =>
        stub.consumeKeyRateLimit("k1", ORG, now),
      ),
    );
    expect(burst.every((r) => r.status === "allowed")).toBe(true);
    await expect(stub.consumeKeyRateLimit("k1", ORG, now)).resolves.toEqual({
      status: "rejected",
      reason: "key_rate_limited",
      retryAfterSeconds: 1,
    });
    await evictDurableObject(stub);
    await expect(
      stub.consumeKeyRateLimit("k1", ORG, now),
    ).resolves.toMatchObject({ reason: "key_rate_limited" });
    await expect(stub.consumeKeyRateLimit("k2", ORG, now)).resolves.toEqual({
      status: "allowed",
    });
    await expect(
      stub.consumeKeyRateLimit("k1", ORG, now + 1000),
    ).resolves.toEqual({ status: "allowed" });
    await expect(
      stub.consumeKeyRateLimit("k1", ORG, now + 1000),
    ).resolves.toMatchObject({ reason: "key_rate_limited" });
    expect(networkCalls).toBe(0);
    __setTestGrantsFetcher(null);
  });
});
