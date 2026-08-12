/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { decryptSecret, webhookBinding } from "./lib/credentialCrypto";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "admin_user";

async function completeSecurityAudit(
  t: TestConvex<typeof schema>,
): Promise<string> {
  const admin = t.withIdentity({ subject: ADMIN } as { subject: string });
  let audit = await admin.mutation(api.securityRollout.startAudit, {});
  while (audit.phase !== "completed" && audit.phase !== "invalidated") {
    audit = await admin.mutation(api.securityRollout.auditPage, {
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

async function seedTransfer(t: TestConvex<typeof schema>): Promise<void> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    await ctx.db.insert("publisherTransfers", {
      publisherOrganizationId: organizationId,
      stripeConnectedAccountId: "acct_operator_view",
      amount: 950,
      amountAtoms: 950_000_000,
      remainderAtoms: 0,
      currency: "usd",
      idempotencyKey: "publisher-transfer:test",
      reversedAmount: 0,
      status: "failed",
      failureReason: "insufficient platform balance",
      createdAt: 1,
      updatedAt: 2,
    });
  });
}

describe("admin publisher transfer operations", () => {
  const priorAdminIds = process.env.ADMIN_USER_IDS;
  const priorEncryptionKeys = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN;
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: "admin-test-v1",
      keys: {
        "admin-test-v1": "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=",
      },
    });
  });
  afterEach(() => {
    if (priorAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdminIds;
    if (priorEncryptionKeys === undefined) {
      delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = priorEncryptionKeys;
    }
  });

  it("migrates legacy webhook secrets once and returns zero-count evidence", async () => {
    const t = convexTest(schema, modules);
    const endpointId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_legacy_webhook",
        name: "Legacy webhook org",
        slug: "legacy-webhook-org",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Legacy webhook project",
        slug: "legacy-webhook-project",
        status: "published",
        visibility: "private",
        tags: [],
      });
      return await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/events",
        secret: "legacy-webhook-plaintext",
        active: true,
        createdAt: 1,
      });
    });
    const admin = t.withIdentity({ subject: ADMIN } as { subject: string });

    const auditId = await completeSecurityAudit(t);

    const first = await admin.mutation(api.admin.migrateSecurityRollout, {
      auditId,
    });
    expect(first.webhookSecrets).toMatchObject({
      scanned: 1,
      current: 1,
      broken: 0,
      plaintext: 1,
      scrubbed: 1,
      isDone: true,
    });

    const stored = await t.run(async (ctx) => ctx.db.get(endpointId));
    expect(stored?.secret).toBeUndefined();
    expect(
      await decryptSecret(stored!, webhookBinding(stored!.projectId)),
    ).toBe("legacy-webhook-plaintext");

    const second = await admin.mutation(api.admin.migrateSecurityRollout, {
      auditId,
    });
    expect(second.webhookSecrets).toMatchObject({
      scanned: 1,
      current: 1,
      old: 0,
      broken: 0,
      plaintext: 0,
      scrubbed: 0,
      isDone: true,
    });
  });

  it("rejects non-admin rollout without touching legacy plaintext", async () => {
    const t = convexTest(schema, modules);
    const endpointId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_guarded_migration",
        name: "Guarded migration",
        slug: "guarded-migration",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Guarded project",
        slug: "guarded-project",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      return await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/events",
        secret: "leave-unchanged",
        active: true,
        createdAt: 1,
      });
    });

    await expect(
      t
        .withIdentity({ subject: "not-admin" } as { subject: string })
        .mutation(api.admin.migrateSecurityRollout, { auditId: "denied" }),
    ).rejects.toThrow("Not authorized as admin");

    expect(await t.run(async (ctx) => ctx.db.get(endpointId))).toMatchObject({
      secret: "leave-unchanged",
    });
  });

  it("preflights legacy key material before touching any plaintext row", async () => {
    const t = convexTest(schema, modules);
    const endpointId = await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_legacy_preflight",
        name: "Legacy preflight",
        slug: "legacy-preflight",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId,
        name: "Legacy preflight project",
        slug: "legacy-preflight-project",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      return await ctx.db.insert("webhookEndpoints", {
        projectId,
        url: "https://example.com/events",
        secret: "preflight-must-not-scrub",
        active: true,
        createdAt: 1,
      });
    });
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: "legacy-v1",
      keys: { "legacy-v1": "arbitrary legacy key material" },
    });
    const admin = t.withIdentity({ subject: ADMIN } as { subject: string });

    await expect(
      admin.query(api.admin.securityRolloutPreflight, {}),
    ).resolves.toEqual({
      current: "legacy-v1",
      boundEnvelopeReady: false,
      legacyCompatibleVersions: ["legacy-v1"],
      legacyOnlyVersions: ["legacy-v1"],
      generation: 0,
      auditRequired: true,
    });

    const audit = await admin.mutation(api.securityRollout.startAudit, {});
    expect(audit).toMatchObject({ phase: "credentials", generation: 0 });
    await expect(
      admin.mutation(api.securityRollout.auditPage, {
        auditId: audit.auditId,
        numItems: 100,
      }),
    ).resolves.toMatchObject({ phase: "webhooks" });
    await expect(
      admin.mutation(api.securityRollout.auditPage, {
        auditId: audit.auditId,
        numItems: 100,
      }),
    ).rejects.toThrow("unavailable for bound envelopes");

    const stored = await t.run(async (ctx) => ctx.db.get(endpointId));
    expect(stored).toMatchObject({ secret: "preflight-must-not-scrub" });
    expect(stored?.ciphertext).toBeUndefined();
    expect(stored?.sealedCiphertext).toBeUndefined();
  });

  it("fails closed for a non-admin", async () => {
    const t = convexTest(schema, modules);
    await seedTransfer(t);
    await expect(
      t
        .withIdentity({ subject: "member" } as { subject: string })
        .query(api.admin.listPublisherTransfers, {
          paginationOpts: { numItems: 10, cursor: null },
        }),
    ).rejects.toThrow("Not authorized as admin");
  });

  it("returns operator-safe Stripe transfer state without a manual destination", async () => {
    const t = convexTest(schema, modules);
    await seedTransfer(t);
    const result = await t
      .withIdentity({ subject: ADMIN } as { subject: string })
      .query(api.admin.listPublisherTransfers, {
        paginationOpts: { numItems: 10, cursor: null },
      });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({
      amount: 950,
      currency: "usd",
      status: "failed",
      failureReason: "insufficient platform balance",
      stripeConnectedAccountId: "acct_operator_view",
      publisherOrganizationName: "Publisher",
      publisherOrganizationSlug: "publisher",
    });
    expect(result.page[0]).not.toHaveProperty("destination");
  });

  it("returns organization labels with only the requested indexed project page", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const alpha = await ctx.db.insert("organizations", {
        clerkOrgId: "org_alpha",
        name: "Alpha Labs",
        slug: "alpha-labs",
      });
      const beta = await ctx.db.insert("organizations", {
        clerkOrgId: "org_beta",
        name: "Beta Labs",
        slug: "beta-labs",
      });
      await ctx.db.insert("projects", {
        organizationId: alpha,
        name: "Alpha draft",
        slug: "alpha-draft",
        status: "draft",
        visibility: "private",
        tags: [],
      });
      await ctx.db.insert("projects", {
        organizationId: beta,
        name: "Beta API",
        slug: "beta-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
    });

    const result = await t
      .withIdentity({ subject: ADMIN } as { subject: string })
      .query(api.admin.listProjects, {
        paginationOpts: { numItems: 1, cursor: null },
        status: "published",
        visibility: "public",
      });

    expect(result.page).toEqual([
      expect.objectContaining({
        name: "Beta API",
        organizationName: "Beta Labs",
        organizationHandle: "beta-labs",
        handle: "beta-labs/beta-api",
      }),
    ]);
    expect(result.isDone).toBe(true);
  });
});

describe("admin project pagination", () => {
  const priorAdminIds = process.env.ADMIN_USER_IDS;
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = ADMIN;
  });
  afterEach(() => {
    if (priorAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdminIds;
  });

  it("applies single filters before pagination and clamps page size", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_admin_filter",
        name: "Filter owner",
        slug: "filter-owner",
      });
      await ctx.db.insert("projects", {
        organizationId,
        name: "Buried published project",
        slug: "buried-published",
        status: "published",
        visibility: "public",
        tags: [],
      });
      for (let index = 0; index < 80; index += 1) {
        await ctx.db.insert("projects", {
          organizationId,
          name: `New draft ${index}`,
          slug: `new-draft-${index}`,
          status: "draft",
          visibility: "public",
          tags: [],
        });
      }
    });
    const admin = t.withIdentity({ subject: ADMIN } as { subject: string });

    const published = await admin.query(api.admin.listProjects, {
      status: "published",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(published.page.map((project) => project.slug)).toEqual([
      "buried-published",
    ]);

    const capped = await admin.query(api.admin.listProjects, {
      visibility: "public",
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(capped.page).toHaveLength(50);
    expect(capped.isDone).toBe(false);
    expect(
      capped.page.every((project) => project.visibility === "public"),
    ).toBe(true);
  });
});
