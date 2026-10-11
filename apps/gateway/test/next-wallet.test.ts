import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { NextWalletDO, AdmissionInput } from "../src/next/wallet";
import type { NextEnv } from "../src/next/snapshots";
import type { Checkpoint, KeyPolicy } from "@zevium/shared/edge/replication";
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
