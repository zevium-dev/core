import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harness } from "./helpers";
import { moneyFixture, eventFor, assertWallet } from "./moneyFixtures";
import { sign } from "../contracts/transport";
import { requestClose } from "../convex/money/barrier";
import { headerBundle } from "../contracts/snapshots";
import { internal } from "../convex/_generated/api";
import { sha256Hex } from "@zevium/shared";
import {
  openProjection,
  sealProjection,
  encryptHeaders,
  decryptHeaders,
  walletPage,
} from "@zevium/shared/edge/replication";
import { grantLot } from "../convex/money/lots";
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
  ).toHaveLength(2);
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
it("authenticates the complete final across signing rotation and replay", async () => {
  vi.stubEnv(
    "NEXT_ADMISSION_KEYS",
    JSON.stringify({ ...ring, current: "two" }),
  );
  const t = harness();
  const f = await t.run((ctx) => moneyFixture(ctx, "signed-final"));
  const event = await t.run((ctx) =>
    eventFor(ctx, f, 1, { admissionKeyId: "one" }),
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
  for (const change of [
    { nonce: "replay" },
    { deploymentId: "foreign" },
    { scope: "foreign" },
    { now: NOW + 30_000 },
    { now: NOW - 1 },
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
    t.query(internal.edgeSnapshots.read, { kind: "keys", scope });
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
