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
    NEXT_CONVEX_SITE_URL: "https://next.invalid",
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
    NEXT_CONVEX_SITE_URL: "https://next.invalid",
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
      expect(await coordinator.read("catalogue", "public")).toBeNull();
      expect(reads).toBe(0); // Cold reads never await control-plane I/O.
      await coordinator.alarm();
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
      expect(reads).toBe(before); // Expired reads also cannot synchronously refresh.
      await ctx.storage.deleteAlarm();
    });
  } finally {
    network.mockRestore();
  }
});
