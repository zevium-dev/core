import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { EdgeSnapshotDO, type NextEnv } from "../src/next/snapshots";
import {
  sealProjection,
  type Projection,
} from "@zevium/shared/edge/replication";

it("persists a large spec and credential projection without truncation", async () => {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.EDGE_SNAPSHOTS!.get(
    bindings.EDGE_SNAPSHOTS!.idFromName(crypto.randomUUID()),
  );
  const ring = {
    current: "one",
    keys: { one: "test-only-snapshot-secret-never-production" },
  };
  const config: NextEnv = {
    ...bindings,
    CONVEX_SITE_URL: "https://next.invalid",
    NEXT_SNAPSHOT_KEYS: JSON.stringify(ring),
  };
  const payload = {
    spec: "s".repeat(393_216),
    ciphertext: "c".repeat(1_100_000),
  };
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const now = Date.now();
      return Response.json(
        await sealProjection(
          {
            deploymentId: "next-fixture",
            kind: "route",
            scope: "large",
            revision: now,
            generationId: "large",
            generatedAt: now,
            expiresAt: now + 30_000,
            nonce: new URL(String(input)).searchParams.get("nonce")!,
            payload,
          },
          ring,
        ),
      );
    });
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeSnapshotDO(ctx, config);
      await ctx.storage.setAlarm(Date.now() + 60_000);
      await coordinator.read("route", "large");
      await coordinator.alarm();
      const result = await coordinator.read("route", "large");
      expect(result).not.toBeNull();
      expect(JSON.parse(result!).payload).toEqual(payload);
      await ctx.storage.deleteAlarm();
    });
  } finally {
    network.mockRestore();
  }
});

it("installs only complete stable catalogue generations and persists them across eviction", async () => {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.EDGE_SNAPSHOTS!.get(
    bindings.EDGE_SNAPSHOTS!.idFromName(crypto.randomUUID()),
  );
  const ring = {
    current: "one",
    keys: { one: "test-only-snapshot-secret-never-production" },
  };
  const config: NextEnv = {
    ...bindings,
    CONVEX_SITE_URL: "https://next.invalid",
    NEXT_SNAPSHOT_KEYS: JSON.stringify(ring),
  };
  let reads = 0,
    pass = 0,
    changed = false;
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      reads++;
      const url = new URL(String(input));
      const second = url.searchParams.has("cursor");
      if (!second) pass++;
      const now = Date.now();
      return Response.json(
        await sealProjection(
          {
            deploymentId: "next-fixture",
            kind: "catalogue",
            scope: "public",
            revision: now,
            generatedAt: now,
            expiresAt: now + 60_000,
            generationId: "page",
            nonce: url.searchParams.get("nonce")!,
            payload: {
              items: [
                second
                  ? changed && pass % 2 === 0
                    ? "revoked"
                    : "second"
                  : "first",
              ],
              nextCursor: second ? null : "page-2",
            },
          },
          ring,
        ),
      );
    });
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeSnapshotDO(ctx, config);
      await ctx.storage.setAlarm(Date.now() + 60_000);
      expect(await coordinator.read("catalogue", "public")).not.toBeNull();
      expect(reads).toBe(4); // Cold reads install the whole bounded generation.
      const first = JSON.parse(
        (await coordinator.read("catalogue", "public"))!,
      ) as Projection;
      expect(first.payload).toEqual({ items: ["first", "second"] });
      expect(reads).toBe(4);
      changed = true;
      await coordinator.alarm();
      const retained = JSON.parse(
        (await coordinator.read("catalogue", "public"))!,
      ) as Projection;
      expect(retained).toEqual(first); // Publish/revoke between passes cannot expose mixed pages.
      await ctx.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeSnapshotDO(ctx, config);
      await ctx.storage.setAlarm(Date.now() + 60_000);
      const before = reads;
      expect(
        JSON.parse((await coordinator.read("catalogue", "public"))!).payload,
      ).toEqual({ items: ["first", "second"] });
      const stored = (await ctx.storage.get<Projection>("current"))!;
      await ctx.storage.put("current", { ...stored, expiresAt: Date.now() });
      expect(await coordinator.read("catalogue", "public")).toBeNull();
      expect(reads).toBe(before + 4); // Changed generation fails the cold fill closed.
      await ctx.storage.deleteAlarm();
    });
  } finally {
    network.mockRestore();
  }
});

it("single-flights missing scopes, keeps no identity, and deletes negative state at expiry", async () => {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.EDGE_SNAPSHOTS!.get(
    bindings.EDGE_SNAPSHOTS!.idFromName(crypto.randomUUID()),
  );
  const ring = {
    current: "one",
    keys: { one: "test-only-snapshot-secret-never-production" },
  };
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const now = Date.now(),
        url = new URL(String(input));
      return Response.json(
        await sealProjection(
          {
            deploymentId: "next-fixture",
            kind: "keys",
            scope: "missing",
            revision: now,
            generationId: "missing",
            generatedAt: now,
            expiresAt: now + 30_000,
            nonce: url.searchParams.get("nonce")!,
            payload: null,
          },
          ring,
        ),
      );
    });
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeSnapshotDO(ctx, {
        ...bindings,
        CONVEX_SITE_URL: "https://next.invalid",
        NEXT_SNAPSHOT_KEYS: JSON.stringify(ring),
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => coordinator.read("keys", "missing")),
      );
      expect(
        results.every((r) => r !== null && JSON.parse(r).payload === null),
      ).toBe(true);
      expect(network).toHaveBeenCalledTimes(1);
      expect(await ctx.storage.get("identity")).toBeUndefined();
      expect([...(await ctx.storage.list()).keys()]).toEqual(["negative"]);
      await coordinator.read("keys", "missing");
      expect(network).toHaveBeenCalledTimes(1);
      await coordinator.alarm();
      expect((await ctx.storage.list()).size).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect(network).toHaveBeenCalledTimes(1);
    });
  } finally {
    network.mockRestore();
  }
});

it("bounds an unresponsive cold fill and leaves no polling or persisted identity", async () => {
  const bindings = env as unknown as NextEnv;
  const stub = bindings.EDGE_SNAPSHOTS!.get(
    bindings.EDGE_SNAPSHOTS!.idFromName(crypto.randomUUID()),
  );
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        ),
    );
  try {
    await runInDurableObject(stub, async (_instance, ctx) => {
      const coordinator = new EdgeSnapshotDO(ctx, {
        ...bindings,
        CONVEX_SITE_URL: "https://next.invalid",
      });
      const start = Date.now();
      expect(await coordinator.read("route", "missing")).toBeNull();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(network).toHaveBeenCalledTimes(1);
      expect((await ctx.storage.list()).size).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  } finally {
    network.mockRestore();
  }
});

it("lists a full manifest with one coordinator read and no route/org warmup", async () => {
  const { nextDeps } = await import("../src/next/pipeline");
  const items = Array.from({ length: 5000 }, (_, i) => ({
    projectId: `p-${i}`,
    publisherHandle: "publisher",
    slug: `api-${i}`,
    name: `API ${i}`,
    tags: [],
    orgName: "Publisher",
    publishedAt: null,
    houseOperated: false,
    specDigest: "a".repeat(64),
    routeRevision: 1,
    pricing: { minCost: 1, maxCost: 1, endpointCount: 1, hasFreeTier: false },
  }));
  const now = Date.now();
  const manifest = await sealProjection(
    {
      deploymentId: "next-fixture",
      kind: "catalogue",
      scope: "public",
      revision: now,
      generationId: "manifest",
      generatedAt: now,
      expiresAt: now + 60_000,
      nonce: "nonce",
      payload: { items },
    },
    {
      current: "key",
      keys: { key: "test-only-snapshot-secret-never-production" },
    },
  );
  const read = vi.fn().mockResolvedValue(JSON.stringify(manifest));
  const namespace = { idFromName: vi.fn(), get: vi.fn(() => ({ read })) };
  const deps = nextDeps({
    NEXT_DEPLOYMENT_ID: "next-fixture",
    EDGE_SNAPSHOTS: namespace as unknown as NextEnv["EDGE_SNAPSHOTS"],
  });
  expect((await deps.catalogueSource!.listPublic()).items).toHaveLength(5000);
  expect(read).toHaveBeenCalledExactlyOnceWith("catalogue", "public");
  read.mockResolvedValue(null);
  await expect(deps.catalogueSource!.listPublic()).rejects.toThrow(/.*/);
});
