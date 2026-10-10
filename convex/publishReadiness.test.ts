/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const fingerprint = await credentialSetFingerprint([]);
    const passing = {
      status: "ok",
      draftHash: hash,
      credentialRevision: 0,
      credentialFingerprint: fingerprint,
      testedAt: now,
    };

    await expect(
      readinessValidity(null, DRAFT_A, 0, fingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "missing",
    });
    await expect(
      readinessValidity(
        { ...passing, status: "reachable_unconfirmed" },
        DRAFT_A,
        0,
        fingerprint,
        now,
      ),
    ).resolves.toEqual({ current: false, reason: "status_not_ok" });
    await expect(
      readinessValidity(
        passing,
        DRAFT_A,
        0,
        fingerprint,
        now + READINESS_TTL_MS + 1,
      ),
    ).resolves.toEqual({ current: false, reason: "expired" });
    await expect(
      readinessValidity(passing, DRAFT_B, 0, fingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "draft_changed",
    });
    await expect(
      readinessValidity(passing, DRAFT_A, 1, fingerprint, now),
    ).resolves.toEqual({
      current: false,
      reason: "credentials_changed",
    });
    await expect(
      readinessValidity(passing, DRAFT_A, 0, fingerprint, now),
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
      baseHash: await draftFingerprint(DRAFT_A),
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
      baseHash: await draftFingerprint(DRAFT_A),
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
      baseHash: await draftFingerprint(DRAFT_A),
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
      baseHash: await draftFingerprint(DRAFT_B),
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
      message: expect.stringContaining("Health check failed"),
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
      baseHash: await draftFingerprint(DRAFT_A),
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

describe("publication with upstream credentials (#389)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeMock.mockReset();
    probeMock.mockResolvedValue({
      outcome: "healthy",
      statusCode: 200,
      latencyMs: 12,
      finalOrigin: "https://httpbin.org",
      message: "Upstream responded successfully without credentials.",
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    probeMock.mockReset();
  });

  async function setup() {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Dogfood readiness", version: "0.0.1" },
      servers: [{ url: "https://httpbin.org" }],
      paths: {
        "/status/200": {
          get: {
            "x-zevium-cost": 1,
            "x-zevium-health-check": true,
            responses: { "200": { description: "Healthy" } },
          },
        },
      },
    });
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec,
        baseHash: await draftFingerprint(DRAFT_A),
      }),
    ).toMatchObject({ ok: true });
    const credential = await admin.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "X-Dogfood-Token",
      secret: "harmless-test-value",
    });
    return { t, admin, projectId, spec, credential };
  }

  it.each(["new", "rotated", "legacy"] as const)(
    "publishes after a passing health check with a %s credential",
    async (kind) => {
      const { t, admin, projectId, spec, credential } = await setup();
      if (kind === "rotated") {
        await admin.mutation(api.upstreamCredentials.upsert, {
          projectId,
          name: "X-Dogfood-Token",
          secret: "rotated-test-value",
        });
      } else if (kind === "legacy") {
        await t.run(async (ctx) => {
          await ctx.db.patch(credential.id, { revision: undefined });
        });
      }

      // Retesting unchanged credentials must remain publishable too.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          admin.action(api.publishReadinessAction.testConnection, {
            projectId,
          }),
        ).resolves.toMatchObject({ status: "ready", statusCode: 200 });
        await expect(
          admin.query(api.publishReadiness.getCurrent, { projectId }),
        ).resolves.toMatchObject({ current: true, reason: null });
      }
      expect(probeMock).toHaveBeenCalledWith(
        "https://httpbin.org/status/200",
        "GET",
      );
      await expect(
        admin.mutation(api.specs.publish, { projectId, version: "0.0.1" }),
      ).resolves.toMatchObject({
        ok: true,
        version: { version: "0.0.1", spec },
        project: { status: "published" },
      });
      expect(
        await admin.query(api.specs.listVersions, { projectId }),
      ).toHaveLength(1);
    },
  );

  it.each(["rotate", "add", "remove"] as const)(
    "requires a fresh health check after credential %s, then permits publication",
    async (change) => {
      const { t, admin, projectId, credential } = await setup();
      // A legacy row dominates the aggregate revision. Membership/fingerprint
      // checks must still detect changes to the other credential at the same time.
      await t.run(async (ctx) => {
        await ctx.db.insert("upstreamCredentials", {
          projectId,
          name: "x-legacy-token",
          secret: "legacy-test-value",
          updatedAt: Date.now(),
        });
      });
      await admin.action(api.publishReadinessAction.testConnection, {
        projectId,
      });
      if (change === "remove") {
        await admin.mutation(api.upstreamCredentials.remove, {
          credentialId: credential.id,
        });
      } else {
        await admin.mutation(api.upstreamCredentials.upsert, {
          projectId,
          name: change === "rotate" ? "X-Dogfood-Token" : "X-Another-Token",
          secret: "changed-test-value",
        });
      }
      await expect(
        admin.query(api.publishReadiness.getCurrent, { projectId }),
      ).resolves.toMatchObject({
        current: false,
        reason: "credentials_changed",
      });
      await expect(
        admin.mutation(api.specs.publish, { projectId, version: "0.0.1" }),
      ).resolves.toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ path: "readiness" })],
      });
      expect(
        await admin.query(api.specs.listVersions, { projectId }),
      ).toHaveLength(0);

      await expect(
        admin.action(api.publishReadinessAction.testConnection, { projectId }),
      ).resolves.toMatchObject({ status: "ready" });
      await expect(
        admin.query(api.publishReadiness.getCurrent, { projectId }),
      ).resolves.toMatchObject({ current: true, reason: null });
      await expect(
        admin.mutation(api.specs.publish, { projectId, version: "0.0.1" }),
      ).resolves.toMatchObject({ ok: true });
    },
  );
});

describe("draft compare-and-swap", () => {
  it("rejects a stale session, preserves the canonical draft and readiness, and allows explicit retry", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);
    const baseHash = await draftFingerprint(DRAFT_A);
    const saved = await admin.mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_B,
      baseHash,
    });
    expect(saved.ok).toBe(true);
    const currentHash = await draftFingerprint(DRAFT_B);
    await t.mutation(internal.publishReadiness.recordPassingTest, {
      projectId,
      draftHash: currentHash,
      healthCheckUrl: "https://api.example.com/ping",
      healthCheckMethod: "GET",
    });
    const conflict = await admin.mutation(api.specs.saveDraft, {
      projectId,
      spec: DRAFT_A,
      baseHash,
    });
    expect(conflict).toMatchObject({
      ok: false,
      conflict: true,
      draft: DRAFT_B,
      draftHash: currentHash,
      lastSavedAt: saved.lastSavedAt,
    });
    expect(await admin.query(api.specs.getDraft, { projectId })).toMatchObject({
      draft: DRAFT_B,
    });
    expect(
      await admin.query(api.publishReadiness.getCurrent, { projectId }),
    ).toMatchObject({ current: true });
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec: DRAFT_A,
        baseHash: currentHash,
      }),
    ).toMatchObject({ ok: true, draft: DRAFT_A });
  });
  it("rejects a missing base against an existing draft and accepts the first save only once", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec: DRAFT_B,
        baseHash: null,
      }),
    ).toMatchObject({ ok: false, conflict: true });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec: DRAFT_A,
        baseHash: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec: DRAFT_B,
        baseHash: null,
      }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(
      await admin.mutation(api.specs.saveDraft, {
        projectId,
        spec: DRAFT_A,
        baseHash: null,
      }),
    ).toMatchObject({ ok: true });
  });
});
