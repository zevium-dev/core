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

const probeMock = vi.hoisted(() => vi.fn());
vi.mock("./qualityProbeAction", () => ({ probePublicHttps: probeMock }));

const modules = import.meta.glob("./**/*.ts");
const DRAFT_A = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "A", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/ping": {
      get: { "x-zevium-cost": 1, "x-zevium-health-check": true },
    },
  },
});
const DRAFT_B = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "B", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/ping": {
      get: { "x-zevium-cost": 1, "x-zevium-health-check": true },
    },
  },
});
const ACTION_DRAFT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Action readiness", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/health": {
      get: { "x-zevium-cost": 1, "x-zevium-health-check": true },
    },
  },
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
  it("requires org admin membership before any upstream probe", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    await expect(
      t
        .withIdentity({
          subject: "member",
          org_id: "org_readiness",
          org_role: "org:member",
        })
        .action(api.publishReadinessAction.testConnection, { projectId }),
    ).rejects.toThrow("organization admins");
    await expect(
      t
        .withIdentity({
          subject: "foreign_admin",
          org_id: "org_foreign",
          org_role: "org:admin",
        })
        .action(api.publishReadinessAction.testConnection, { projectId }),
    ).rejects.toThrow("Not a member");
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("rejects missing, stale, changed, and non-passing readiness", async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const hash = await draftFingerprint(DRAFT_A);
    const passing = {
      status: "ok",
      draftHash: hash,
      testedAt: now,
    };

    await expect(readinessValidity(null, DRAFT_A, now)).resolves.toEqual({
      current: false,
      reason: "missing",
    });
    await expect(
      readinessValidity(
        { ...passing, status: "reachable_unconfirmed" },
        DRAFT_A,
        now,
      ),
    ).resolves.toEqual({ current: false, reason: "status_not_ok" });
    await expect(
      readinessValidity(passing, DRAFT_A, now + READINESS_TTL_MS + 1),
    ).resolves.toEqual({ current: false, reason: "expired" });
    await expect(readinessValidity(passing, DRAFT_B, now)).resolves.toEqual({
      current: false,
      reason: "draft_changed",
    });
    await expect(readinessValidity(passing, DRAFT_A, now)).resolves.toEqual({
      current: true,
      reason: null,
    });
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
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: oldHash,
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
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
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
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
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
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
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
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
    probeMock.mockResolvedValueOnce({
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 12,
      finalOrigin: "https://example.com",
      message: "Upstream responded successfully without credentials.",
    });
    await expect(
      asAdmin(t).action(api.publishReadinessAction.testConnection, {
        projectId,
      }),
    ).resolves.toMatchObject({ status: "ready", statusCode: 204 });

    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({
      current: true,
      reason: null,
      readiness: {
        status: "ok",
        draftHash: await draftFingerprint(ACTION_DRAFT),
        healthCheckUrl: "https://example.com/health",
        healthCheckMethod: "GET",
      },
    });
    expect(probeMock).toHaveBeenCalledWith("https://example.com/health", "GET");
  });

  it("reports reachability but rejects an unhealthy declared health response", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    probeMock.mockResolvedValueOnce({
      outcome: "http_error",
      statusCode: 401,
      latencyMs: 9,
      finalOrigin: "https://api.example.com",
      message:
        "Upstream is reachable without credentials but returned HTTP 401.",
    });
    await expect(
      asAdmin(t).action(api.publishReadinessAction.testConnection, {
        projectId,
      }),
    ).resolves.toMatchObject({
      status: "reachable_unhealthy",
      statusCode: 401,
    });
    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: false });
  });

  it("blocks 5xx and invalidates an earlier pass for the same draft", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    probeMock.mockResolvedValueOnce({
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 8,
      finalOrigin: "https://api.example.com",
      message: "Upstream responded successfully without credentials.",
    });
    await asAdmin(t).action(api.publishReadinessAction.testConnection, {
      projectId,
    });
    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: true });

    probeMock.mockResolvedValueOnce({
      outcome: "http_error",
      statusCode: 503,
      latencyMs: 11,
      finalOrigin: "https://api.example.com",
      message:
        "Upstream is reachable without credentials but returned HTTP 503.",
    });
    await expect(
      asAdmin(t).action(api.publishReadinessAction.testConnection, {
        projectId,
      }),
    ).resolves.toMatchObject({
      status: "reachable_unhealthy",
      statusCode: 503,
      message: expect.stringContaining("Publication gate failed"),
    });
    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: false, reason: "missing" });
    await expect(
      asAdmin(t).mutation(api.specs.publish, {
        projectId,
        version: "1.0.0",
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "readiness" })],
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("specVersions").collect()),
    ).toHaveLength(0);
  });

  it("does not let a delayed failed probe clear a pass for a newer draft", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const oldHash = await draftFingerprint(DRAFT_A);
    await asAdmin(t).mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_B,
    });
    const newHash = await draftFingerprint(DRAFT_B);
    expect(
      await t.mutation(internal.publishReadiness.recordPassingTest, {
        projectId,
        draftHash: newHash,
        healthCheckUrl: "https://api.example.com/ping",
        healthCheckMethod: "GET",
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.publishReadiness.clearPassingTest, {
        projectId,
        draftHash: oldHash,
      }),
    ).toBe(false);
    await expect(
      asAdmin(t).query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: true });
  });
});
