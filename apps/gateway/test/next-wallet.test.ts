import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { NextWalletDO, type AdmissionInput } from "../src/next/wallet";
import type { NextEnv } from "../src/next/snapshots";
import {
  sealProjection,
  type Checkpoint,
  type KeyPolicy,
} from "@zevium/shared/edge/replication";
const key: KeyPolicy = {
  keyId: "key",
  secretSha256: "a".repeat(64),
  ownerUserId: "user",
  subjectUserId: "user",
  keyFamilyId: "family",
  budgetId: "budget",
  budgetRevision: 1,
  scopes: [],
  lifecycle: "active",
  edgeRevision: 1,
};
async function setup(amounts = [100]) {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.NEXT_WALLET!.get(
    bindings.NEXT_WALLET!.idFromName(crypto.randomUUID()),
  );
  const now = Date.now();
  const cp: Checkpoint = {
    protocolVersion: 2,
    deploymentId: "next-fixture",
    walletId: "wallet",
    ownerKey: "org:org_test",
    owner: { kind: "org", organizationId: "org", clerkOrgId: "org_test" },
    balance: amounts.reduce((a, b) => a + b, 0),
    promoCredits: 0,
    sequence: 1,
    epoch: 1,
    gateRevision: 1,
    gateState: "open",
    settledThroughEdgeSequence: 0,
    generatedAt: now,
    validUntil: now + 30_000,
    generationId: "generation",
    page: 0,
    lots: [],
    sources: [],
    keyPolicies: [],
  };
  await runInDurableObject(stub, (_wallet: NextWalletDO, ctx) => {
    ctx.storage.sql.exec(
      "INSERT INTO next_state VALUES(1,?)",
      JSON.stringify({ checkpoint: cp, nextSequence: 0, sealed: false }),
    );
    for (const [i, amount] of amounts.entries()) {
      const lot = {
        lotId: `lot-${i}`,
        walletId: "wallet",
        sourceRef: `source-${i}`,
        createdAt: i,
        remainingCredits: amount,
        expiryClass: "never",
        sourceKind: i === 0 ? "promo" : "payment",
        refundable: i !== 0,
        priority: i === 0 ? 0 : 2,
      };
      const source = {
        lotId: lot.lotId,
        originLotId: lot.lotId,
        sourceRef: lot.sourceRef,
        sourceCreatedAt: i,
        remainingCredits: amount,
      };
      ctx.storage.sql.exec(
        "INSERT INTO next_sources VALUES(?,?,?,?,?,?,?,?,?)",
        JSON.stringify([lot.lotId, lot.lotId]),
        lot.lotId,
        JSON.stringify({ lot, source }),
        amount,
        lot.priority,
        i,
        i,
        lot.lotId,
        null,
      );
    }
  });
  return stub;
}
function input(cost = 5): AdmissionInput {
  const id = crypto.randomUUID();
  return {
    protocolVersion: 2,
    deploymentId: "next-fixture",
    consumerClerkOrgId: "org_test",
    publisherOrganizationId: "publisher",
    projectId: "project",
    specVersionId: "version",
    specVersion: "1",
    specDigest: "b".repeat(64),
    operationId: "echo",
    endpoint: "/echo",
    method: "POST",
    reservationId: id,
    settleRefId: `settle:${id}`,
    admittedAt: Date.now(),
    listedCostCredits: cost,
    keyId: "key",
  };
}
async function stop(stub: DurableObjectStub<NextWalletDO>) {
  await runInDurableObject(stub, (_w, ctx) => ctx.storage.deleteAlarm());
}
it("serializes two simultaneous last-credit admissions before dispatch", async () => {
  const stub = await setup([5]);
  const results = await Promise.all([
    stub.admit(input(5), key, Date.now() + 30_000),
    stub.admit(input(5), key, Date.now() + 30_000),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toMatchObject({
    status: 402,
    reason: "insufficient_credits",
  });
  await runInDurableObject(stub, (_w, ctx) => {
    expect(
      ctx.storage.sql.exec("SELECT seq FROM next_calls").toArray(),
    ).toEqual([{ seq: 1 }]);
  });
  await stop(stub);
});
it("allocates promo first, stops at 32 original sources and survives eviction", async () => {
  const stub = await setup(Array(33).fill(1));
  expect(await stub.admit(input(33), key, Date.now() + 30_000)).toMatchObject({
    ok: false,
    reason: "funding_capacity_exceeded",
  });
  const a = await stub.admit(input(32), key, Date.now() + 30_000);
  expect(a.ok).toBe(true);
  if (a.ok) {
    expect(a.admission.fundingSlices).toHaveLength(32);
    expect(a.admission.fundingSlices[0].sourceRef).toBe("source-0");
  }
  await stop(stub);
  await evictDurableObject(stub);
  expect(await stub.admit(input(2), key, Date.now() + 30_000)).toMatchObject({
    ok: false,
    reason: "insufficient_credits",
  });
  await stop(stub);
});
it("zero balance blocks zero-price calls; cap, disable and rate contracts stay distinct", async () => {
  const empty = await setup([0]);
  expect(await empty.admit(input(0), key, Date.now() + 30_000)).toMatchObject({
    ok: false,
    status: 402,
  });
  await stop(empty);
  const stub = await setup([100]);
  expect(
    await stub.admit(
      input(5),
      { ...key, monthlyCapCredits: 4 },
      Date.now() + 30_000,
    ),
  ).toMatchObject({ ok: false, status: 402, reason: "key_cap_exceeded" });
  expect(
    await stub.admit(
      input(0),
      { ...key, lifecycle: "disabled" },
      Date.now() + 30_000,
    ),
  ).toMatchObject({ ok: false, status: 403 });
  let result;
  for (let i = 0; i < 61; i++)
    result = await stub.admit(input(0), key, Date.now() + 30_000);
  expect(result).toMatchObject({ ok: false, status: 429, retryAfter: 1 });
  await stop(stub);
});
it("signs complete finals and keeps spent/reserved family totals across requests", async () => {
  const stub = await setup();
  const a = await stub.admit(
    input(5),
    { ...key, monthlyCapCredits: 5 },
    Date.now() + 30_000,
  );
  expect(a.ok).toBe(true);
  if (a.ok) await stub.finalize(a.admission.reservationId, 200, 10);
  expect(
    await stub.admit(
      input(1),
      { ...key, monthlyCapCredits: 5 },
      Date.now() + 30_000,
    ),
  ).toMatchObject({ ok: false, reason: "key_cap_exceeded" });
  await runInDurableObject(stub, (_w, ctx) => {
    const row = ctx.storage.sql
      .exec<{ final: string }>("SELECT final FROM next_calls")
      .one();
    expect(JSON.parse(row.final)).toMatchObject({
      edgeSequence: 1,
      credits: 5,
      admissionKeyId: "k1",
      finalFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
  await stop(stub);
});

it("cold-fills once, renews unchanged sources, logs rejected finals and prunes only resolved state", async () => {
  const stub = await setup();
  const ring = {
    current: "k1",
    keys: { k1: "test-only-secret-never-use-in-production" },
  };
  const alert = vi.spyOn(console, "error").mockImplementation(() => {});
  await runInDurableObject(stub, async (_wallet, ctx) => {
    const wallet = new NextWalletDO(ctx, {
      ...(env as unknown as NextEnv),
      CONVEX_SITE_URL: "https://next.invalid",
      NEXT_SNAPSHOT_KEYS: JSON.stringify(ring),
    });
    const original = JSON.parse(
      ctx.storage.sql
        .exec<{ data: string }>("SELECT data FROM next_state")
        .one().data,
    );
    original.checkpoint.validUntil = 0;
    ctx.storage.sql.exec(
      "UPDATE next_state SET data=?",
      JSON.stringify(original),
    );
    await ctx.storage.put({
      owner: "org_test",
      bootstrapId: "bootstrap",
      activated: true,
    });
    let resolved = false,
      refId = "";
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/ingest-usage")
          return Response.json({
            results: [
              {
                refId,
                status: resolved ? "exception" : "rejected",
                ...(!resolved
                  ? { reason: "Final evidence rejected", retryable: false }
                  : {}),
              },
            ],
          });
        const now = Date.now();
        const inventory = ctx.storage.sql
          .exec<{ data: string }>("SELECT data FROM next_sources")
          .toArray()
          .map((r) => JSON.parse(r.data));
        const cp = {
          ...original.checkpoint,
          edgeBootstrapId: "bootstrap",
          generatedAt: now,
          validUntil: now + 30_000,
          generationId: resolved
            ? "resolved"
            : original.checkpoint.generationId,
          settledThroughEdgeSequence: resolved ? 1 : 0,
          lots: inventory.map((r) => r.lot),
          sources: inventory.map((r) => r.source),
        };
        return Response.json(
          await sealProjection(
            {
              deploymentId: "next-fixture",
              kind: "wallet",
              scope: "org_test",
              revision: now,
              generationId: cp.generationId,
              generatedAt: now,
              expiresAt: now + 30_000,
              nonce: url.searchParams.get("nonce")!,
              payload: { checkpoint: cp },
            },
            ring,
          ),
        );
      });
    try {
      const request = input(5);
      const admitted = await wallet.admit(request, key, Date.now() + 30_000);
      expect(admitted.ok).toBe(true);
      expect(network).toHaveBeenCalledTimes(1);
      refId = request.settleRefId;
      expect(
        ctx.storage.sql
          .exec<{ available: number }>("SELECT available FROM next_sources")
          .one().available,
      ).toBe(95);
      await wallet.alarm();
      // The same generation must not rewrite 100 credits over the active 5-credit hold.
      expect(
        ctx.storage.sql
          .exec<{ available: number }>("SELECT available FROM next_sources")
          .one().available,
      ).toBe(95);
      await wallet.finalize(request.reservationId, 200, 10);
      await wallet.alarm();
      expect(alert).toHaveBeenCalledWith(
        expect.stringContaining('"event":"next_settlement_failure"'),
      );
      expect(
        ctx.storage.sql
          .exec<{ ack: string | null }>("SELECT ack FROM next_calls")
          .one().ack,
      ).toBeNull();
      expect(
        ctx.storage.sql.exec("SELECT * FROM next_failures").toArray(),
      ).toHaveLength(2);
      await wallet.alarm();
      expect(alert).toHaveBeenCalledTimes(1); // Repeated rejections do not spam alerts.
      const evidence = await wallet.failureEvidence(refId);
      expect(evidence).toMatchObject({
        expectedWatermark: 0,
        expectedFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        reason: "Final evidence rejected",
      });
      expect(JSON.parse(evidence!.eventJson).settleRefId).toBe(refId);
      expect(await wallet.failureEvidence("unknown")).toBeNull();
      resolved = true;
      await wallet.alarm();
      expect(
        ctx.storage.sql.exec("SELECT * FROM next_calls").toArray(),
      ).toHaveLength(0);
      expect(
        ctx.storage.sql.exec("SELECT * FROM next_failures").toArray(),
      ).toHaveLength(0);
      expect(
        ctx.storage.sql
          .exec<{ available: number }>("SELECT available FROM next_sources")
          .one().available,
      ).toBe(100);
      expect(await wallet.failureEvidence(refId)).toBeNull();
      const now = Date.now(),
        day = new Date(now).toISOString().slice(0, 10),
        month = day.slice(0, 7);
      for (const [id, value, at] of [
        ["free:old:2000-01-01", 1, now],
        ["budget:old:2000-01", 1, now],
        ["rate:old", 0, now - 61_000],
        [`free:current:${day}`, 1, now],
        [`budget:current:${month}`, 1, now],
        ["rate:current", 0, now],
      ] as const)
        ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO next_counters VALUES(?,?,?)",
          id,
          value,
          at,
        );
      const state = JSON.parse(
        ctx.storage.sql
          .exec<{ data: string }>("SELECT data FROM next_state")
          .one().data,
      );
      ctx.storage.sql.exec(
        "UPDATE next_state SET data=?",
        JSON.stringify({ ...state, lastAdmit: 0 }),
      );
      await ctx.storage.put("lastWake", 0);
      await wallet.alarm();
      const counters = ctx.storage.sql
        .exec<{ id: string }>("SELECT id FROM next_counters")
        .toArray()
        .map((r) => r.id);
      expect(counters).not.toContain("rate:old");
      expect(counters).not.toContain("free:old:2000-01-01");
      expect(counters).not.toContain("budget:old:2000-01");
      expect(counters).toEqual(
        expect.arrayContaining([
          "rate:current",
          `free:current:${day}`,
          `budget:current:${month}`,
        ]),
      );
      expect(await ctx.storage.getAlarm()).toBeNull();
      await wallet.wake("org_test");
      expect(await ctx.storage.getAlarm()).not.toBeNull();
    } finally {
      network.mockRestore();
      await ctx.storage.deleteAlarm();
    }
  });
  alert.mockRestore();
});
