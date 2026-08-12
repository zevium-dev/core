/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptCredential } from "./lib/credentialCrypto";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "security_rollout_admin";
const KEYRING = JSON.stringify({
  current: "security-rollout-v1",
  keys: {
    "security-rollout-v1":
      "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=",
  },
});

type Seed = {
  projectId: Id<"projects">;
};

async function seedProject(t: TestConvex<typeof schema>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_security_rollout",
      name: "Security rollout",
      slug: "security-rollout",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Security API",
      slug: "security-api",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Security API", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {},
      }),
      lastSavedAt: 1,
    });
    return { projectId };
  });
}

function admin(t: TestConvex<typeof schema>) {
  return t.withIdentity({ subject: ADMIN } as { subject: string });
}

function publisher(t: TestConvex<typeof schema>) {
  return t.withIdentity({
    subject: "user_security_owner",
    org_id: "org_security_rollout",
    org_slug: "security-rollout",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

async function completeAudit(t: TestConvex<typeof schema>): Promise<string> {
  const caller = admin(t);
  let audit = await caller.mutation(api.securityRollout.startAudit, {});
  while (audit.phase !== "completed" && audit.phase !== "invalidated") {
    audit = await caller.mutation(api.securityRollout.auditPage, {
      auditId: audit.auditId,
      numItems: 100,
    });
  }
  expect(audit).toMatchObject({
    phase: "completed",
    zeroCorruption: true,
    corrupt: 0,
    broken: 0,
  });
  return audit.auditId;
}

describe("security rollout audit fence", () => {
  const previousAdminIds = process.env.ADMIN_USER_IDS;
  const previousKeyring = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN;
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = KEYRING;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previousAdminIds;
    if (previousKeyring === undefined) {
      delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = previousKeyring;
    }
  });

  it("does not scrub first 100 rows before malformed row 102 is audited", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("upstreamCredentials", {
          projectId,
          name: `x-legacy-${String(index).padStart(3, "0")}`,
          secret: `legacy-${index}`,
          updatedAt: index,
        });
      }
      await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-malformed-tail",
        ciphertext: "partial-envelope",
        updatedAt: 102,
      });
      await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/security-events",
        secret: "legacy-webhook-secret",
        active: true,
        createdAt: 1,
      });
    });

    const caller = admin(t);
    let audit = await caller.mutation(api.securityRollout.startAudit, {});
    audit = await caller.mutation(api.securityRollout.auditPage, {
      auditId: audit.auditId,
      numItems: 100,
    });
    expect(audit).toMatchObject({
      phase: "credentials",
      credentialsScanned: 100,
      plaintext: 100,
    });
    expect(
      await t.run(async (ctx) => {
        const rows = await ctx.db.query("upstreamCredentials").collect();
        return rows.filter((row) => row.secret !== undefined).length;
      }),
    ).toBe(101);

    while (audit.phase !== "completed" && audit.phase !== "invalidated") {
      audit = await caller.mutation(api.securityRollout.auditPage, {
        auditId: audit.auditId,
        numItems: 100,
      });
    }
    expect(audit).toMatchObject({
      phase: "completed",
      credentialsScanned: 102,
      webhooksScanned: 1,
      zeroCorruption: false,
      corrupt: 1,
      broken: 1,
    });
    await expect(
      t.mutation(internal.upstreamCredentials.migrateLegacyPlaintext, {
        auditId: audit.auditId,
        numItems: 100,
      }),
    ).rejects.toThrow("zero-corruption security audit");
    expect(
      await t.run(async (ctx) => {
        const rows = await ctx.db.query("upstreamCredentials").collect();
        return rows.filter((row) => row.secret !== undefined).length;
      }),
    ).toBe(101);
  });

  it("invalidates a paged audit when a credential write changes generation", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("upstreamCredentials", {
          projectId,
          name: `x-audit-${String(index).padStart(3, "0")}`,
          secret: `legacy-${index}`,
          updatedAt: index,
        });
      }
    });
    const caller = admin(t);
    let audit = await caller.mutation(api.securityRollout.startAudit, {});
    audit = await caller.mutation(api.securityRollout.auditPage, {
      auditId: audit.auditId,
      numItems: 100,
    });
    expect(audit.phase).toBe("credentials");

    await publisher(t).mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "newest-secret",
    });
    audit = await caller.mutation(api.securityRollout.auditPage, {
      auditId: audit.auditId,
      numItems: 100,
    });
    expect(audit).toMatchObject({
      phase: "invalidated",
      zeroCorruption: false,
    });
    await expect(
      t.mutation(internal.upstreamCredentials.migrateLegacyPlaintext, {
        auditId: audit.auditId,
      }),
    ).rejects.toThrow("zero-corruption security audit");
  });

  it("preserves newest encrypted value across migration/write race", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "authorization",
        secret: "legacy-secret",
        updatedAt: 1,
      });
    });
    const auditId = await completeAudit(t);

    const [migration, write] = await Promise.allSettled([
      t.mutation(internal.upstreamCredentials.migrateLegacyPlaintext, {
        auditId,
        numItems: 100,
      }),
      publisher(t).mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "authorization",
        secret: "concurrent-newest-secret",
      }),
    ]);
    expect(write.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(migration.status);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("upstreamCredentials")
        .withIndex("by_project_name", (q) =>
          q.eq("projectId", projectId).eq("name", "authorization"),
        )
        .unique(),
    );
    expect(stored?.secret).toBeUndefined();
    expect(stored?.revision).toBeGreaterThanOrEqual(1);
    expect(
      await decryptCredential(stored!, projectId, "authorization"),
    ).toBe("concurrent-newest-secret");
  });

  it("invalidates readiness on same-millisecond credential replacement", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const owner = publisher(t);
    await owner.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "first-secret",
    });
    const target = await t.query(internal.publishReadiness.getTarget, {
      projectId,
      clerkOrgId: "org_security_rollout",
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
    await expect(
      owner.query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({ current: true, reason: null });

    await owner.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "second-secret",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("upstreamCredentials")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revision: 2,
      updatedAt: 1_800_000_000_000,
    });
    await expect(
      owner.query(api.publishReadiness.getCurrent, { projectId }),
    ).resolves.toMatchObject({
      current: false,
      reason: "credentials_changed",
    });
  });
});
