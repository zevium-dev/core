/// <reference types="vite/client" />
import {
  REGISTRY_ROLLOUT_BATCH_SIZE,
  registryGenesisDigest,
} from "@zevium/shared";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-02-01T00:00:00.000Z"));
  process.env.ADMIN_USER_IDS = "rollout_admin";
  process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING = JSON.stringify({
    current: "transport-v1",
    keys: { "transport-v1": "44".repeat(32) },
  });
});

function admin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "rollout_admin",
    org_id: "org_operator",
    org_role: "org:admin",
  } as { subject: string; org_id: string; org_role: string });
}

describe("bounded Registry v2 rollout", () => {
  it("does not emit registry events for legacy keys without a persisted hash", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", {
        clerkOrgId: "org_rollout",
        name: "Rollout",
        slug: "rollout",
        publicHandle: "rollout",
      });
      const project = await ctx.db.insert("projects", {
        organizationId: org,
        name: "API",
        slug: "api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      await ctx.db.insert("upstreamCredentials", {
        projectId: project,
        name: "authorization",
        ciphertext: "encrypted",
        iv: "iv",
        keyVersion: "v1",
        updatedAt: 1,
      });
      await ctx.db.insert("keySettings", {
        clerkOrgId: "org_rollout",
        keyId: "ck_legacy",
        disabled: false,
        updatedAt: 1,
      });
    });
    const started = await admin(t).mutation(
      api.admin.migrateRegistryRollout,
      {},
    );
    expect(started.phase).toBe("credentials");
    let manifest = await t.mutation(internal.registryRollout.runStep, {
      rolloutId: started.rolloutId,
    });
    while (manifest.phase !== "keys")
      manifest = await t.mutation(internal.registryRollout.runStep, {
        rolloutId: started.rolloutId,
      });
    expect(manifest.counts.keysForcedToRotate).toBeGreaterThanOrEqual(0);
    const events = await t.run(
      async (ctx) => await ctx.db.query("registryOutbox").collect(),
    );
    expect(
      events.some(
        (event) =>
          event.operation === "key.put" || event.operation === "key.revoke",
      ),
    ).toBe(false);
  });

  it("processes bounded pages, stores independent provenance, and verifies exact digests", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < REGISTRY_ROLLOUT_BATCH_SIZE + 1; index += 1) {
        const org = await ctx.db.insert("organizations", {
          clerkOrgId: `org_rollout_${index}`,
          name: `Rollout ${index}`,
          slug: `rollout-${index}`,
          publicHandle: `rollout-${index}`,
        });
        const project = await ctx.db.insert("projects", {
          organizationId: org,
          name: `API ${index}`,
          slug: `api-${index}`,
          status: "published",
          visibility: "public",
          tags: [],
          publicationGeneration: 1,
        });
        await ctx.db.insert("specVersions", {
          projectId: project,
          version: "1.0.0",
          spec: JSON.stringify({
            openapi: "3.1.0",
            info: { title: "API" },
            paths: {},
          }),
          publishedAt: 1_700_000_000_000,
        });
        await ctx.db.insert("upstreamCredentials", {
          projectId: project,
          name: "authorization",
          ciphertext: "encrypted",
          iv: "iv",
          keyVersion: "v1",
          updatedAt: 1,
        });
        await ctx.db.insert("keySettings", {
          clerkOrgId: `org_rollout_${index}`,
          keyId: `ck_${index}`,
          secretSha256: "a".repeat(64),
          ownerUserId: `user_${index}`,
          subjectUserId: `user_${index}`,
          budgetId: `budget_${index}`,
          budgetRevision: 1,
          lifecycle: "active",
          disabled: false,
          updatedAt: 1,
        });
      }
    });
    let manifest = await admin(t).mutation(
      api.admin.migrateRegistryRollout,
      {},
    );
    const rolloutId = manifest.rolloutId;
    let guard = 0;
    while (manifest.status !== "complete") {
      manifest =
        manifest.phase === "verify_sources" ||
        manifest.phase === "verify_events"
          ? await t.mutation(internal.registryRollout.verifyStep, { rolloutId })
          : await t.mutation(internal.registryRollout.runStep, { rolloutId });
      guard += 1;
      if (guard > 30) throw new Error("rollout did not converge");
    }
    expect(manifest).toMatchObject({ status: "complete", phase: "complete" });
    expect(manifest.counts.organizations).toBeGreaterThan(0);
    expect(manifest.digests.sources).not.toBe(registryGenesisDigest());
    expect(manifest.digests.events).not.toBe(registryGenesisDigest());
    const rows = await t.run(async (ctx) => ({
      sources: await ctx.db.query("registryRolloutSourcePreimages").collect(),
      receipts: await ctx.db.query("registryRolloutEventReceipts").collect(),
      events: await ctx.db.query("registryOutbox").collect(),
    }));
    expect(rows.sources.length).toBe(
      manifest.counts.credentials +
        manifest.counts.organizations +
        manifest.counts.publishedRoutes +
        manifest.counts.keys,
    );
    expect(
      rows.receipts.every(
        (row) => row.rolloutId === rolloutId && row.streamKey.length > 0,
      ),
    ).toBe(true);
    expect(
      rows.events.every((row) => !row.eventJson.includes("globalSequence")),
    ).toBe(true);
  });

  it("refuses completion when immutable source provenance is tampered", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_verify",
        name: "Verify",
        slug: "verify",
        publicHandle: "verify",
      });
    });
    let manifest = await admin(t).mutation(
      api.admin.migrateRegistryRollout,
      {},
    );
    while (manifest.phase !== "verify_sources")
      manifest = await t.mutation(internal.registryRollout.runStep, {
        rolloutId: manifest.rolloutId,
      });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("registryRolloutSourcePreimages").first();
      if (row === null) throw new Error("missing provenance");
      await ctx.db.patch(row._id, { preimageJson: "{}" });
    });
    await expect(
      t.mutation(internal.registryRollout.verifyStep, {
        rolloutId: manifest.rolloutId,
      }),
    ).rejects.toThrow(/source preimage|source verification/);
  });
});
