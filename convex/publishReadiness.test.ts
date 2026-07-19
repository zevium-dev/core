/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  draftFingerprint,
  READINESS_TTL_MS,
  readinessValidity,
} from "./publishReadiness";
import schema from "./schema";

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
    const passing = {
      status: "ok",
      draftHash: hash,
      credentialRevision: 10,
      testedAt: now,
    };

    await expect(readinessValidity(null, DRAFT_A, 10, now)).resolves.toEqual({
      current: false,
      reason: "missing",
    });
    await expect(
      readinessValidity(
        { ...passing, status: "reachable_unconfirmed" },
        DRAFT_A,
        10,
        now,
      ),
    ).resolves.toEqual({ current: false, reason: "status_not_ok" });
    await expect(
      readinessValidity(passing, DRAFT_A, 10, now + READINESS_TTL_MS + 1),
    ).resolves.toEqual({ current: false, reason: "expired" });
    await expect(readinessValidity(passing, DRAFT_B, 10, now)).resolves.toEqual(
      {
        current: false,
        reason: "draft_changed",
      },
    );
    await expect(readinessValidity(passing, DRAFT_A, 11, now)).resolves.toEqual(
      {
        current: false,
        reason: "credentials_changed",
      },
    );
    await expect(readinessValidity(passing, DRAFT_A, 10, now)).resolves.toEqual(
      {
        current: true,
        reason: null,
      },
    );
  });

  it("does not let a delayed test overwrite readiness for a newer saved draft", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const oldHash = await draftFingerprint(DRAFT_A);
    const newHash = await draftFingerprint(DRAFT_B);

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
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
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

  it("invalidates readiness when an imported draft autosave wins a delayed test", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const oldHash = await draftFingerprint(DRAFT_A);

    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
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
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        asAdmin(t).action(api.publishReadinessAction.testConnection, {
          projectId,
        }),
      ).resolves.toMatchObject({ status: "ok", statusCode: 204 });
    } finally {
      vi.unstubAllGlobals();
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
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
