import { env } from "cloudflare:workers";
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
      keySettings: [{ keyId: "k1", disabled: true }],
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
      keySettings: [{ keyId: "k1", disabled: false, monthlyCapCredits: 100 }],
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

    // A key without a settings row is unaffected.
    const r3 = await stub.reserve("r3", 1, {
      keyId: "k_other",
      clerkOrgId: ORG,
    });
    expect(r3.status).toBe("reserved");
  });

  it("counts active reservations plus requested cost at the cap boundary", async () => {
    const stub = walletStub("key-cap-concurrent");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [{ keyId: "k1", disabled: false, monthlyCapCredits: 100 }],
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

  it("allows a rotated (grace) key before graceUntil, rejects after", async () => {
    const stub = walletStub("key-grace");
    const now = 1_000_000;
    const grace = now + 60_000;
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [{ keyId: "k_old", disabled: false, graceUntil: grace }],
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

  it("key with no settings row is allowed (unrestricted)", async () => {
    const stub = walletStub("key-none");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [],
    });
    const res = await stub.reserve("r1", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(res.status).toBe("reserved");
  });

  it("reserve without opts skips key enforcement (back-compat)", async () => {
    const stub = walletStub("key-nocall");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [{ keyId: "k1", disabled: true }],
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
        keySettings: [{ keyId: "k1", disabled: true }],
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

    // Unknown key but fresh sync → no refresh; key allowed (unrestricted).
    const res = await stub.reserve("r1", 5, {
      keyId: "unknown",
      clerkOrgId: ORG,
    });
    expect(res.status).toBe("reserved");
    expect(fetchCount).toBe(primedFetches);
  });

  it("refreshes a known key after its control checkpoint becomes stale", async () => {
    const stub = walletStub("key-stale-known");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [{ keyId: "k1", disabled: false }],
    });

    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1_000, sequence: 1 },
        keySettings: [{ keyId: "k1", disabled: true }],
      };
    });

    const res = await stub.reserve("r1", 5, {
      keyId: "k1",
      clerkOrgId: ORG,
      nowMs: Date.now() + 61_000,
    });

    expect(res).toEqual({ status: "rejected", reason: "key_disabled" });
    expect(fetchCount).toBe(1);
  });

  it("concurrent unknown-key reserves share a single fetch (single-flight)", async () => {
    const stub = walletStub("key-concurrent");
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1000, sequence: 0 },
        keySettings: [{ keyId: "k_shared", disabled: true }],
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
