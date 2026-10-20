import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harness, identity } from "./helpers";
import { moneyFixture, eventFor, assertWallet } from "./moneyFixtures";
import { sign, fingerprint } from "../contracts/transport";
import { requestClose, finishClose } from "../convex/money/barrier";
import { headerBundle } from "../contracts/snapshots";
import { api, internal } from "../convex/_generated/api";
import { sha256Hex } from "@zevium/shared";
import {
  openProjection,
  sealProjection,
  encryptHeaders,
  decryptHeaders,
  walletPage,
} from "@zevium/shared/edge/replication";
import { grantLot } from "../convex/money/lots";
import { drain } from "./financeFixtures";
import { NOW, SECRET } from "./fixtures";
const ring = { current: "one", keys: { one: SECRET, two: SECRET + "rotated" } };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_DEPLOYMENT_ID", "next-fixture");
  vi.stubEnv("NEXT_SNAPSHOT_KEYS", JSON.stringify(ring));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("retries cold-wallet wakes without treating delivery as a drain ACK", async () => {
  vi.stubEnv("NEXT_GATEWAY_URL", "https://gateway.invalid");
  vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "wake"));
  const wallet = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(new Response(null, { status: 202 }));
  await t.run((ctx) => requestClose(ctx, f.walletId, "wake-close", "refund"));
  expect(
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  ).toHaveLength(1);
  await t.action(internal.edgeMaintenance.wakeWallet, {
    clerkOrgId: wallet.owner.clerkOrgId,
  });
  await t.mutation(internal.edgeMaintenance.recover, { cursor: null });
  expect(
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  ).toHaveLength(3);
  await t.action(internal.edgeMaintenance.wakeWallet, {
    clerkOrgId: wallet.owner.clerkOrgId,
  });
  expect(network).toHaveBeenLastCalledWith(
    new URL("https://gateway.invalid/internal/next-wake"),
    expect.objectContaining({
      body: JSON.stringify({
        clerkOrgId: wallet.owner.clerkOrgId,
        deploymentId: "next-fixture",
      }),
    }),
  );
  expect(
    (await t.run((ctx) => ctx.db.get(f.walletId)))?.close?.ackAt,
  ).toBeUndefined();
});
it("claims cold closing wallets once without adopting a missing journal", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "cold-claim"));
  const wallet = (await t.run((ctx) => ctx.db.get(f.walletId)))!;
  await t.run((ctx) => requestClose(ctx, f.walletId, "cold-refund", "refund"));
  const args = {
    clerkOrgId: wallet.owner.clerkOrgId,
    deploymentId: "next-fixture",
    bootstrapId: crypto.randomUUID(),
  };
  await t.mutation(internal.edgeSnapshots.activate, args);
  await t.mutation(internal.edgeSnapshots.activate, args);
  await expect(
    t.mutation(internal.edgeSnapshots.activate, {
      ...args,
      bootstrapId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("already claimed");
  expect((await t.run((ctx) => ctx.db.get(f.walletId)))?.edgeBootstrapId).toBe(
    args.bootstrapId,
  );
  const other = await t.run((ctx) => moneyFixture(ctx, "lost-prior-epoch"));
  await t.run((ctx) => ctx.db.patch(other.walletId, { epoch: 2 }));
  const otherWallet = (await t.run((ctx) => ctx.db.get(other.walletId)))!;
  await expect(
    t.mutation(internal.edgeSnapshots.activate, {
      ...args,
      clerkOrgId: otherWallet.owner.clerkOrgId,
    }),
  ).rejects.toThrow("recovery required");
});
it("activates a mirrored org without a wallet at zero balance and no grant", async () => {
  const t = harness();
  await t
    .withIdentity(identity("mirrored"))
    .mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_mirrored",
    });
  expect(await t.run((ctx) => ctx.db.query("wallets").collect())).toEqual([]);
  const args = {
    clerkOrgId: "org_mirrored",
    deploymentId: "next-fixture",
    bootstrapId: crypto.randomUUID(),
  };
  await t.mutation(internal.edgeSnapshots.activate, args);
  await t.mutation(internal.edgeSnapshots.activate, args);
  const wallets = await t.run((ctx) => ctx.db.query("wallets").collect());
  expect(wallets).toHaveLength(1);
  expect(wallets[0]).toMatchObject({
    ownerKey: "org:org_mirrored",
    balance: 0,
    promoCredits: 0,
    sequence: 0,
    epoch: 1,
    gateState: "open",
    edgeBootstrapId: args.bootstrapId,
  });
  expect(await t.run((ctx) => ctx.db.query("walletEntries").collect())).toEqual(
    [],
  );
  expect(await t.run((ctx) => ctx.db.query("fundingLots").collect())).toEqual(
    [],
  );
  const page = walletPage.parse(
    (
      await t.query(internal.edgeSnapshots.read, {
        now: Date.now(),
        kind: "wallet",
        scope: "org_mirrored",
      })
    ).payload,
  );
  expect(page.checkpoint).toMatchObject({ balance: 0, sources: [] });
  await t.run(async (ctx) => {
    const org = (name: string) => ({
      clerkOrgId: `org_${name}`,
      slug: name,
      name,
      publicHandle: name,
      lastClerkEventAt: 0,
      revision: 1,
    });
    await ctx.db.insert("organizations", {
      ...org("archived"),
      archivedAt: Date.now(),
    });
    await ctx.db.insert("organizations", org("tomb"));
    await ctx.db.insert("orgTombstones", {
      clerkOrgId: "org_tomb",
      sourceTimestamp: Date.now(),
      archivedAt: Date.now(),
    });
  });
  for (const clerkOrgId of ["org_archived", "org_tomb", "org_unknown"])
    await expect(
      t.mutation(internal.edgeSnapshots.activate, {
        ...args,
        clerkOrgId,
        bootstrapId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Wallet unavailable");
  expect(await t.run((ctx) => ctx.db.query("wallets").collect())).toHaveLength(
    1,
  );
});
it("authenticates the complete final across signing rotation and replay", async () => {
  vi.stubEnv(
    "NEXT_ADMISSION_KEYS",
    JSON.stringify({ ...ring, current: "two" }),
  );
  const t = harness();
  const f = await t.run((ctx) => moneyFixture(ctx, "signed-final"));
  const event = await t.run((ctx) =>
    eventFor(ctx, f, 1, { admissionKeyId: "one" }, false),
  );
  const settle = (value: unknown) =>
    t.mutation(internal.wallets.settleEvent, {
      eventJson: JSON.stringify(value),
    });
  expect(await settle(event)).toMatchObject({
    status: "rejected",
    reason: "Final evidence rejected",
  });
  event.finalFingerprint = await sign(
    { purpose: "final:v2", facts: event },
    SECRET,
  );
  expect(
    await settle({ ...event, latencyMs: event.latencyMs + 1 }),
  ).toMatchObject({ status: "rejected", reason: "Final evidence rejected" });
  expect(await settle(event)).toMatchObject({ status: "applied" });
  expect(await settle(event)).toMatchObject({ status: "already_applied" });
  expect(await t.run((ctx) => assertWallet(ctx, f.walletId))).toMatchObject({
    balance: 95,
  });
});
it("binds nonce, scope, deployment, lifetime, digest and rotated signing identity", async () => {
  const facts = {
    deploymentId: "next-fixture",
    kind: "org" as const,
    scope: "org_one",
    revision: 1,
    generationId: "g",
    generatedAt: NOW,
    expiresAt: NOW + 30_000,
    nonce: "nonce",
    payload: { archived: false },
  };
  const p = await sealProjection(facts, ring),
    expected = { ...facts, minimumRevision: 1, now: NOW, keys: ring.keys };
  expect(await openProjection(p, expected)).toEqual(p);
  expect(await openProjection(p, { ...expected, now: NOW - 1000 })).toEqual(p);
  for (const change of [
    { nonce: "replay" },
    { deploymentId: "foreign" },
    { scope: "foreign" },
    { now: NOW + 30_000 },
    { now: NOW - 1001 },
    { minimumRevision: 2 },
  ])
    await expect(openProjection(p, { ...expected, ...change })).rejects.toThrow(
      /.+/,
    );
  await expect(
    openProjection({ ...p, payload: { archived: true } }, expected),
  ).rejects.toThrow(/.+/);
  const rotated = await sealProjection(facts, { ...ring, current: "two" });
  expect(await openProjection(rotated, expected)).toEqual(rotated);
  await expect(
    openProjection(p, { ...expected, keys: { two: ring.keys.two } }),
  ).rejects.toThrow(/.+/);
});
it("encrypts private headers with environment/project/revision AAD and rotation overlap", async () => {
  const binding = ["next-fixture", "project", 2],
    headers = { authorization: "Bearer secret" };
  const encrypted = await encryptHeaders(headers, binding, ring);
  expect(JSON.stringify(encrypted)).not.toContain("Bearer secret");
  expect(
    await decryptHeaders(encrypted, binding, { ...ring, current: "two" }),
  ).toEqual(headers);
  await expect(
    decryptHeaders(encrypted, ["foreign", "project", 2], ring),
  ).rejects.toThrow(/.+/);
  await expect(
    decryptHeaders(encrypted, ["next-fixture", "project", 3], ring),
  ).rejects.toThrow(/.+/);
  const many = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [`x-secret-${i}`, "s".repeat(4096)]),
  );
  const bundle = headerBundle.parse(await encryptHeaders(many, binding, ring));
  expect(await decryptHeaders(bundle, binding, ring)).toEqual(many);
});
it("pins every wallet inventory page and rejects a concurrent grant before installation", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "paged", Array(101).fill(1)));
  const owner = (await t.run((ctx) => ctx.db.get(f.walletId)))!.owner
    .clerkOrgId;
  const first = walletPage.parse(
    (
      await t.query(internal.edgeSnapshots.read, {
        now: Date.now(),
        kind: "wallet",
        scope: owner,
      })
    ).payload,
  );
  expect(first.checkpoint.sources).toHaveLength(100);
  expect(first.checkpoint.nextCursor).toBeTruthy();
  const second = walletPage.parse(
    (
      await t.query(internal.edgeSnapshots.read, {
        now: Date.now(),
        kind: "wallet",
        scope: owner,
        cursor: first.checkpoint.nextCursor,
      })
    ).payload,
  );
  expect(second.checkpoint.generationId).toBe(first.checkpoint.generationId);
  expect(second.checkpoint.sources).toHaveLength(1);
  await t.run((ctx) =>
    grantLot(ctx, {
      walletId: f.walletId,
      sourceRef: "concurrent-grant",
      sourceKind: "admin",
      credits: 1,
    }),
  );
  await expect(
    t.query(internal.edgeSnapshots.read, {
      now: Date.now(),
      kind: "wallet",
      scope: owner,
      cursor: first.checkpoint.nextCursor,
    }),
  ).rejects.toThrow("generation changed");
});
it("membership receipts and user deletion revoke snapshots before paged cleanup", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "revocation"));
  const scope = await sha256Hex("revocation");
  const read = () =>
    t.query(internal.edgeSnapshots.read, {
      now: Date.now(),
      kind: "keys",
      scope,
    });
  expect((await read()).payload).toMatchObject({ keys: [{ keyId: f.keyId }] });
  await t.run(async (ctx) => {
    const w = (await ctx.db.get(f.walletId))!;
    await ctx.db.insert("webhookReceipts", {
      provider: "clerk",
      account: "instance",
      eventId: "removed",
      eventType: "organizationMembership.deleted",
      objectId: `membership:${w.owner.clerkOrgId}:${f.ownerUserId}`,
      sourceTimestamp: NOW,
      receivedAt: NOW,
      state: "complete",
      attempts: 0,
      deliveries: 1,
    });
  });
  expect((await read()).payload).toMatchObject({ keys: [] });
  const other = await t.run((ctx) => moneyFixture(ctx, "user-delete"));
  await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkUserId: other.ownerUserId,
      lastClerkEventAt: NOW,
      deletedAt: NOW,
    }),
  );
  expect(
    (
      await t.query(internal.edgeSnapshots.read, {
        now: Date.now(),
        kind: "keys",
        scope: await sha256Hex("user-delete"),
      })
    ).payload,
  ).toMatchObject({ keys: [] });
});
it("private routes remain hidden and retired public routes retain 410 evidence", async () => {
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "route-policy"));
  const org = await t.run((ctx) => ctx.db.get(f.publisher));
  await t.run(async (ctx) => {
    await ctx.db.patch(f.version, {
      deprecatedAt: NOW - 2000,
      sunsetAt: NOW - 1000,
    });
    await ctx.db.patch(f.project, {
      status: "published",
      latestVersionId: f.version,
    });
    await ctx.db.insert("routeTombstones", {
      publisherHandle: org!.publicHandle,
      projectSlug: "echo",
      organizationId: f.publisher,
      projectId: f.project,
      reservedAt: NOW,
      revision: 1,
    });
  });
  const read = (consumer: string) =>
    t.query(internal.edgeSnapshots.read, {
      now: Date.now(),
      kind: "route",
      scope: JSON.stringify([org!.publicHandle, "echo", consumer]),
    });
  expect((await read("foreign")).payload).toBeNull();
  expect((await read(org!.clerkOrgId)).payload).toMatchObject({
    visibility: "private",
    retired: false,
  });
  expect((await read(org!.clerkOrgId)).payload).not.toHaveProperty("sunsetAt");
  await t.run(async (ctx) => {
    await ctx.db.patch(f.project, {
      desiredVisibility: "public",
      retirement: {
        state: "retired",
        revision: 2,
        message: "Retired",
        startedAt: NOW - 1000,
        sunsetAt: NOW,
        retiredAt: NOW,
        cleanupPhase: "complete",
      },
    });
  });
  expect((await read("foreign")).payload).toMatchObject({
    visibility: "public",
    retired: true,
  });
});

it("recovers an exact rejected final through an audited zero-debit operator exception", async () => {
  vi.stubEnv("NEXT_ADMISSION_KEYS", JSON.stringify(ring));
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "operator-final"));
  const event = await t.run((ctx) =>
    eventFor(ctx, f, 1, { admissionKeyId: "one" }, false),
  );
  // Authentic durable admission, but lost/corrupt final proof cannot auto-settle.
  const eventJson = JSON.stringify(event);
  expect(
    await t.mutation(internal.wallets.settleEvent, { eventJson }),
  ).toMatchObject({ status: "rejected", retryable: false });
  const args = {
    eventJson,
    expectedFingerprint: await fingerprint(event),
    expectedWatermark: 0,
    reason: "Verified durable admission; final proof lost",
  };
  await expect(
    t.mutation(internal.wallets.recoverRejectedSettlement, {
      ...args,
      expectedWatermark: 1,
    }),
  ).rejects.toThrow("watermark changed");
  await expect(
    t.mutation(internal.wallets.recoverRejectedSettlement, {
      ...args,
      expectedFingerprint: "wrong",
    }),
  ).rejects.toThrow("evidence changed");
  expect(
    await t.mutation(internal.wallets.recoverRejectedSettlement, args),
  ).toMatchObject({ status: "exception" });
  expect(
    await t.mutation(internal.wallets.recoverRejectedSettlement, args),
  ).toMatchObject({ status: "exception" });
  expect(
    await t.mutation(internal.wallets.settleEvent, { eventJson }),
  ).toMatchObject({ status: "exception" });
  const wallet = await t.run((ctx) => ctx.db.get(f.walletId));
  expect(wallet).toMatchObject({ balance: 100, settledThroughEdgeSequence: 1 });
  expect(
    await t.run((ctx) => ctx.db.query("usageEvents").collect()),
  ).toHaveLength(1);
  expect(
    await t.run((ctx) => ctx.db.query("publisherEarnings").collect()),
  ).toHaveLength(0);
  expect(
    await t.run((ctx) => ctx.db.query("financeReconciliationCases").collect()),
  ).toHaveLength(2);
});
it("records authentic contiguous finals after a closed gate as zero-debit exceptions", async () => {
  vi.stubEnv("NEXT_ADMISSION_KEYS", JSON.stringify(ring));
  const t = harness(),
    f = await t.run((ctx) => moneyFixture(ctx, "closed-final"));
  const event = await t.run((ctx) =>
    eventFor(ctx, f, 1, { admissionKeyId: "one" }, false),
  );
  event.finalFingerprint = await sign(
    { purpose: "final:v2", facts: event },
    SECRET,
  );
  await t.run((ctx) => ctx.db.patch(f.walletId, { gateState: "closed" }));
  expect(
    await t.mutation(internal.wallets.settleEvent, {
      eventJson: JSON.stringify(event),
    }),
  ).toMatchObject({ status: "exception" });
  expect(await t.run((ctx) => ctx.db.get(f.walletId))).toMatchObject({
    balance: 100,
    settledThroughEdgeSequence: 1,
  });
});
it("uses the HTTP action's supplied clock for query projection freshness", async () => {
  const t = harness();
  const first = await t.query(internal.edgeSnapshots.read, {
    kind: "keys",
    scope: "missing",
    now: NOW,
  });
  const second = await t.query(internal.edgeSnapshots.read, {
    kind: "keys",
    scope: "missing",
    now: NOW + 5000,
  });
  expect(second.generatedAt).toBe(first.generatedAt + 5000);
  expect(second.expiresAt).toBe(first.expiresAt + 5000);
});

it("wakes reopened wallets and retries failed delivery after they leave the closing scan", async () => {
  vi.stubEnv("NEXT_GATEWAY_URL", "https://gateway.invalid");
  vi.stubEnv("GATEWAY_INTERNAL_SECRET", SECRET);
  const t = harness();
  const f = await t.run((ctx) => moneyFixture(ctx, "reopen-wake"));
  await t.run((ctx) => requestClose(ctx, f.walletId, "reopen", "refund"));
  await t.run((ctx) => drain(ctx, f.walletId));
  const before = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const reopened = await t.run((ctx) => finishClose(ctx, f.walletId, "reopen"));
  expect(reopened).toMatchObject({ gateState: "open", epoch: 2 });
  const scheduled = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled).toHaveLength(before.length + 1);
  expect(scheduled.at(-1)?.args).toEqual([
    { clerkOrgId: reopened.owner.clerkOrgId },
  ]);
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 503 }));
  await t.action(internal.edgeMaintenance.wakeWallet, {
    clerkOrgId: reopened.owner.clerkOrgId,
  });
  const retry = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(retry).toHaveLength(scheduled.length + 1);
  expect(retry.at(-1)).toMatchObject({
    args: [{ clerkOrgId: reopened.owner.clerkOrgId, attempt: 1 }],
    scheduledTime: NOW + 1000,
  });
  await t.action(internal.edgeMaintenance.wakeWallet, {
    clerkOrgId: reopened.owner.clerkOrgId,
    attempt: 3,
  });
  expect(
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  ).toHaveLength(retry.length);
  expect(network).toHaveBeenCalledTimes(2);
  expect((await t.run((ctx) => ctx.db.get(f.walletId)))?.epoch).toBe(2);
});
