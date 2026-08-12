/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  credentialSetFingerprint,
  draftFingerprint,
  READINESS_TTL_MS,
  readinessValidity,
} from "./publishReadiness";
import schema from "./schema";

const probeMock = vi.hoisted(() => vi.fn());
vi.mock("./lib/readinessTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/readinessTransport")>()),
  probePinnedHttps: probeMock,
}));

const modules = import.meta.glob("./**/*.ts");
const DRAFT_A = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "A", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: { "/ping": { get: { "x-zevium-cost": 1 } } },
});
const DRAFT_B = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "B", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: { "/ping": { get: { "x-zevium-cost": 1 } } },
});
const ACTION_DRAFT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Action readiness", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: { "/health": { get: { "x-zevium-cost": 1 } } },
});

type Seed = { projectId: Id<"projects"> };

async function seed(t: TestConvex<typeof schema>): Promise<Seed> {
  return t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_readiness",
      name: "Readiness",
      slug: "readiness",
      publicHandle: "readiness",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Readiness API",
      slug: "readiness-api",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: DRAFT_A,
      lastSavedAt: Date.now(),
    });
    return { projectId };
  });
}

function asAdmin(t: TestConvex<typeof schema>) {
  return t.withIdentity({
    subject: "user_readiness",
    org_id: "org_readiness",
    org_role: "org:admin",
  });
}

describe("publish readiness validity", () => {
  it("rejects missing, stale, changed, credential-changed, and non-2xx readiness", async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const hash = await draftFingerprint(DRAFT_A);
    const credentialFingerprint = "credential-fingerprint-a";
    const passing = {
      status: "ok",
      draftHash: hash,
      credentialRevision: 10,
      credentialFingerprint,
      testedAt: now,
    };

    await expect(
      readinessValidity(null, DRAFT_A, 10, credentialFingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "missing",
    });
    await expect(
      readinessValidity(
        { ...passing, status: "reachable_unconfirmed" },
        DRAFT_A,
        10,
        credentialFingerprint,
        now,
      ),
    ).resolves.toEqual({ current: false, reason: "status_not_ok" });
    await expect(
      readinessValidity(
        passing,
        DRAFT_A,
        10,
        credentialFingerprint,
        now + READINESS_TTL_MS + 1,
      ),
    ).resolves.toEqual({ current: false, reason: "expired" });
    await expect(
      readinessValidity(passing, DRAFT_B, 10, credentialFingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "draft_changed",
    });
    await expect(
      readinessValidity(passing, DRAFT_A, 11, credentialFingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "credentials_changed",
    });
    await expect(
      readinessValidity(passing, DRAFT_A, 10, "deleted-set", now),
    ).resolves.toEqual({
      current: false,
      reason: "credentials_changed",
    });
    await expect(
      readinessValidity(passing, DRAFT_A, 10, credentialFingerprint, now),
    ).resolves.toEqual({
      current: true,
      reason: null,
    });
  });

  it("does not let a delayed test overwrite readiness for a newer saved draft", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const oldHash = await draftFingerprint(DRAFT_A);
    const newHash = await draftFingerprint(DRAFT_B);
    const credentialFingerprint = await credentialSetFingerprint([]);

    await t.run(async (ctx) => {
      const draft = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique();
      if (draft === null) throw new Error("Missing seeded draft");
      await ctx.db.patch(draft._id, {
        draft: DRAFT_B,
        lastSavedAt: Date.now(),
      });
    });
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: newHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        credentialFingerprint,
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        credentialFingerprint,
      }),
    ).toBe(false);

    const readiness = await t.run(async (ctx) =>
      ctx.db
        .query("publishReadiness")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique(),
    );
    expect(readiness?.draftHash).toBe(newHash);
  });

  it("invalidates a passing public readiness query when a non-newest credential is deleted", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);
    const target = await t.run(async (ctx) => {
      await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-older",
        secret: "old-secret",
        updatedAt: 10,
      });
      await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-newer",
        secret: "new-secret",
        updatedAt: 20,
      });
      return await ctx.runQuery(internal.publishReadiness.getTarget, {
        projectId,
        clerkOrgId: "org_readiness",
      });
    });
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: target.draftHash!,
        serverOrigin: "https://api.example.com",
        credentialRevision: target.credentialRevision,
        credentialFingerprint: target.credentialFingerprint,
      }),
    ).toBe(true);

    const olderId = await t.run(async (ctx) =>
      ctx.db
        .query("upstreamCredentials")
        .withIndex("by_project_name", (q) =>
          q.eq("projectId", projectId).eq("name", "x-older"),
        )
        .unique(),
    );
    if (olderId === null) throw new Error("Missing credential");
    await admin.mutation(api.upstreamCredentials.remove, {
      credentialId: olderId._id,
    });

    await expect(
      admin.query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({
      current: false,
      reason: "credentials_changed",
    });
  });

  it("invalidates readiness when an imported draft autosave wins a delayed test", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const oldHash = await draftFingerprint(DRAFT_A);
    const credentialFingerprint = await credentialSetFingerprint([]);

    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        credentialFingerprint,
      }),
    ).toBe(true);

    const save = await asAdmin(t).mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_B,
    });
    expect(save.ok).toBe(true);
    expect(save.draftHash).toBe(await draftFingerprint(DRAFT_B));
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        credentialFingerprint,
      }),
    ).toBe(false);
    const readiness = await t.run(async (ctx) =>
      ctx.db
        .query("publishReadiness")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique(),
    );
    expect(readiness).toBeNull();
  });

  it("preserves readiness and save timestamp for a byte-identical draft", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);
    const credentialFingerprint = await credentialSetFingerprint([]);
    const initialSave = await admin.mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_B,
    });
    if (!initialSave.ok || !initialSave.draftHash) {
      throw new Error("Expected initial draft save to succeed");
    }
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: initialSave.draftHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        credentialFingerprint,
      }),
    ).toBe(true);

    const identicalSave = await admin.mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_B,
    });
    expect(identicalSave).toMatchObject({
      ok: true,
      draftHash: initialSave.draftHash,
      lastSavedAt: initialSave.lastSavedAt,
    });
    await expect(
      admin.query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: true, reason: null });

    await admin.mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_A,
    });
    await expect(
      admin.query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({
      current: false,
      reason: "missing",
      readiness: null,
    });
  });

  it("persists a 2xx connection action that remains current in a fresh query", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    await t.run(async (ctx) => {
      const draft = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique();
      if (draft === null) throw new Error("Missing seeded draft");
      await ctx.db.patch(draft._id, {
        draft: ACTION_DRAFT,
        lastSavedAt: Date.now(),
      });
    });
    probeMock.mockResolvedValue({
      statusCode: 204,
      finalUrl: new URL("https://example.com/"),
    });
    try {
      await expect(
        asAdmin(t).action(api.publishReadinessAction.testConnection, {
          projectId,
        }),
      ).resolves.toMatchObject({ status: "ok", statusCode: 204 });
    } finally {
      probeMock.mockReset();
    }

    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({
      current: true,
      reason: null,
      readiness: {
        status: "ok",
        draftHash: await draftFingerprint(ACTION_DRAFT),
        credentialRevision: 0,
        serverOrigin: "https://example.com",
      },
    });
  });
});
