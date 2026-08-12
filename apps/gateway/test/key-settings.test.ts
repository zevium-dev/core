import {
  createExecutionContext,
  env,
  evictDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_NONCE_HEADER,
  EDGE_KEY_REVOCATION_SCHEMA_VERSION,
  EDGE_KEY_REVOCATION_SIGNATURE_HEADER,
  EDGE_KEY_REVOCATION_TIMESTAMP_HEADER,
  edgeKeyRevocationBody,
  edgeKeyRevocationBodySha256,
  parseEdgeKeyRevocationAck,
  signEdgeKeyRevocationRequest,
  verifyEdgeKeyRevocationAck,
} from "@zevium/shared";
import worker, { type Env } from "../src/index";
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
      keySettings: [{ keyId: "k1", familyId: "family-1", disabled: true }],
    });

    const res = await stub.reserve("r1", 10, { keyId: "k1", clerkOrgId: ORG });
    expect(res).toEqual({ status: "rejected", reason: "key_disabled" });
  });

  it("rejects when monthly settled credits reach the cap (boundary)", async () => {
    const stub = walletStub("key-cap");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1000 }],
      keySettings: [
        {
          keyId: "k1",
          familyId: "family-1",
          disabled: false,
          monthlyCapCredits: 100,
        },
        { keyId: "k_other", familyId: "family-other", disabled: false },
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

  it("counts active reservations plus requested cost at the cap boundary", async () => {
    const stub = walletStub("key-cap-concurrent");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [
        {
          keyId: "k1",
          familyId: "family-1",
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
        familyId: "family-stable",
        disabled: false,
        monthlyCapCredits: 100,
        graceUntil: Date.now() + 60_000,
      },
      {
        keyId: "k_new",
        familyId: "family-stable",
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
          familyId: "family-1",
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
      keySettings: [{ keyId: "k1", familyId: "family-1", disabled: true }],
    });
    const res = await stub.reserve("r1", 10);
    expect(res.status).toBe("reserved");
  });

  it("applies monotonic revocation immediately and survives stale sync plus restart", async () => {
    const stub = walletStub("key-immediate-revocation");
    await seed(stub, {
      balance: 1_000,
      keySettings: [
        { keyId: "k1", familyId: "family-1", disabled: false },
      ],
    });

    await expect(stub.applyKeyRevocation(ORG, "k1", 9)).resolves.toEqual({
      status: "applied",
      revision: 9,
    });
    const attempts = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        stub.reserve(`revoked-${index}`, 1, {
          keyId: "k1",
          clerkOrgId: ORG,
        }),
      ),
    );
    expect(attempts).toEqual(
      Array.from({ length: 32 }, () => ({
        status: "rejected",
        reason: "key_disabled",
      })),
    );

    await expect(stub.applyKeyRevocation(ORG, "k1", 8)).resolves.toEqual({
      status: "stale",
      revision: 9,
    });
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: ORG, balance: 1_000, sequence: 1 },
      keySettings: [
        { keyId: "k1", familyId: "family-1", disabled: false },
      ],
    }));
    await expect(
      stub.syncGrants(ORG, Date.now() + 61_000),
    ).resolves.toMatchObject({ status: "ok" });
    __setTestGrantsFetcher(null);
    await expect(stub.authorizeKey("k1", ORG)).resolves.toEqual({
      status: "rejected",
      reason: "key_disabled",
    });

    await evictDurableObject(stub);
    await expect(stub.authorizeKey("k1", ORG)).resolves.toEqual({
      status: "rejected",
      reason: "key_disabled",
    });
    await expect(
      stub.applyKeyRevocation("org_wrong", "k1", 10),
    ).resolves.toEqual({ status: "rejected", reason: "org_mismatch" });
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
        keySettings: [{ keyId: "k1", familyId: "family-1", disabled: true }],
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

  it("refreshes a known key after its control checkpoint becomes stale", async () => {
    const stub = walletStub("key-stale-known");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [{ keyId: "k1", familyId: "family-1", disabled: false }],
    });

    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1_000, sequence: 1 },
        keySettings: [{ keyId: "k1", familyId: "family-1", disabled: true }],
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

  it("fails closed when stale positive key state cannot be refreshed", async () => {
    const stub = walletStub("key-stale-refresh-failure");
    await seed(stub, {
      grants: [{ refId: "g1", amount: 1_000 }],
      keySettings: [{ keyId: "k1", familyId: "family-1", disabled: false }],
    });
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return null;
    });

    await expect(
      stub.reserve("r1", 5, {
        keyId: "k1",
        clerkOrgId: ORG,
        nowMs: Date.now() + 61_000,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "key_untracked" });
    expect(fetchCount).toBe(1);
  });

  it("concurrent unknown-key reserves share a single fetch (single-flight)", async () => {
    const stub = walletStub("key-concurrent");
    let fetchCount = 0;
    __setTestGrantsFetcher(async () => {
      fetchCount += 1;
      return {
        wallet: { clerkOrgId: ORG, balance: 1000, sequence: 0 },
        keySettings: [
          { keyId: "k_shared", familyId: "family-1", disabled: true },
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

describe("HTTP edge key revocation", () => {
  beforeEach(() => {
    __setTestGrantsFetcher(null);
  });
  afterEach(() => {
    __setTestGrantsFetcher(null);
  });

  it("applies signed revocation immediately and returns bound ACK", async () => {
    const secret = "gateway-internal-secret-32bytes!!";
    const testEnv = {
      ...env,
      GATEWAY_INTERNAL_SECRET: secret,
    } as Env;
    // HTTP path selects Wallet DO by clerkOrgId name, same as grant/sync.
    const stub = walletStub(ORG);
    await seed(stub, {
      balance: 500,
      keySettings: [{ keyId: "k1", familyId: "family-1", disabled: false }],
    });

    const event = {
      schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
      eventId: "ekr_http_test_0001",
      clerkOrgId: ORG,
      keyId: "k1",
      revision: 4,
      occurredAt: Date.now(),
      reason: "membership_deleted" as const,
    };
    const body = edgeKeyRevocationBody(event);
    const timestamp = String(Date.now());
    const nonce = "nonce_http_edge_revoc_01";
    const signature = await signEdgeKeyRevocationRequest(
      secret,
      timestamp,
      nonce,
      body,
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://gateway.test/internal/key-revocation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EDGE_KEY_REVOCATION_TIMESTAMP_HEADER]: timestamp,
          [EDGE_KEY_REVOCATION_NONCE_HEADER]: nonce,
          [EDGE_KEY_REVOCATION_SIGNATURE_HEADER]: signature,
        },
        body,
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const rawAck = await response.text();
    const ackSig =
      response.headers.get(EDGE_KEY_REVOCATION_ACK_SIGNATURE_HEADER) ?? "";
    await expect(
      verifyEdgeKeyRevocationAck(secret, timestamp, nonce, rawAck, ackSig),
    ).resolves.toBe(true);
    const ack = parseEdgeKeyRevocationAck(JSON.parse(rawAck) as unknown);
    expect(ack.eventId).toBe(event.eventId);
    expect(ack.bodySha256).toBe(await edgeKeyRevocationBodySha256(body));
    expect(ack.status).toBe("applied");
    expect(ack.revision).toBe(4);

    await expect(
      stub.reserve("post-revocation", 1, { keyId: "k1", clerkOrgId: ORG }),
    ).resolves.toEqual({ status: "rejected", reason: "key_disabled" });

    // Replay with same revision is stale/duplicate style identity ACK.
    const replayCtx = createExecutionContext();
    const replay = await worker.fetch(
      new Request("https://gateway.test/internal/key-revocation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EDGE_KEY_REVOCATION_TIMESTAMP_HEADER]: timestamp,
          [EDGE_KEY_REVOCATION_NONCE_HEADER]: nonce,
          [EDGE_KEY_REVOCATION_SIGNATURE_HEADER]: signature,
        },
        body,
      }),
      testEnv,
      replayCtx,
    );
    await waitOnExecutionContext(replayCtx);
    expect(replay.status).toBe(200);
    const replayAck = parseEdgeKeyRevocationAck(
      JSON.parse(await replay.text()) as unknown,
    );
    expect(replayAck.status).toBe("stale");
  });

  it("rejects forged signature before wallet mutation", async () => {
    const secret = "gateway-internal-secret-32bytes!!";
    const testEnv = {
      ...env,
      GATEWAY_INTERNAL_SECRET: secret,
    } as Env;
    const forgedOrg = "org_forged_sig";
    const stub = walletStub(forgedOrg);
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId: forgedOrg, balance: 500, sequence: 0 },
      keySettings: [
        { keyId: "k_forged", familyId: "family-forged", disabled: false },
      ],
    }));
    await stub.syncGrants(forgedOrg);
    __setTestGrantsFetcher(null);
    const event = {
      schemaVersion: EDGE_KEY_REVOCATION_SCHEMA_VERSION,
      eventId: "ekr_http_forged_0001",
      clerkOrgId: forgedOrg,
      keyId: "k_forged",
      revision: 9,
      occurredAt: Date.now(),
      reason: "admin_revoked" as const,
    };
    const body = edgeKeyRevocationBody(event);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://gateway.test/internal/key-revocation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EDGE_KEY_REVOCATION_TIMESTAMP_HEADER]: String(Date.now()),
          [EDGE_KEY_REVOCATION_NONCE_HEADER]: "nonce_http_edge_forged01",
          [EDGE_KEY_REVOCATION_SIGNATURE_HEADER]: `v1=${"ab".repeat(32)}`,
        },
        body,
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
    await expect(
      stub.reserve("still-live", 1, {
        keyId: "k_forged",
        clerkOrgId: forgedOrg,
      }),
    ).resolves.toMatchObject({ status: "reserved" });
  });
});
