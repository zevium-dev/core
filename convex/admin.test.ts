/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { decryptSecret } from "./lib/credentialCrypto";

const modules = import.meta.glob("./**/*.ts");
const ADMIN = "admin_user";

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
      currency: "usd",
      idempotencyKey: "publisher-transfer:test",
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
      keys: { "admin-test-v1": "admin-rollout-test-key-material" },
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

    const first = await admin.mutation(api.admin.migrateSecurityRollout, {});
    expect(first.webhookSecrets).toEqual({ migrated: 1, remaining: 0 });
    expect(first.remainingWebhookPlaintext).toBe(0);
    expect(first.remainingWebhookUnencrypted).toBe(0);

    const stored = await t.run(async (ctx) => ctx.db.get(endpointId));
    expect(stored?.secret).toBeUndefined();
    expect(
      await decryptSecret({
        ciphertext: stored!.ciphertext!,
        iv: stored!.iv!,
        keyVersion: stored!.keyVersion!,
      }),
    ).toBe("legacy-webhook-plaintext");

    const second = await admin.mutation(api.admin.migrateSecurityRollout, {});
    expect(second.webhookSecrets).toEqual({ migrated: 0, remaining: 0 });
    expect(second.remainingWebhookPlaintext).toBe(0);
    expect(second.remainingWebhookUnencrypted).toBe(0);
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
        .mutation(api.admin.migrateSecurityRollout, {}),
    ).rejects.toThrow("Not authorized as admin");

    expect(await t.run(async (ctx) => ctx.db.get(endpointId))).toMatchObject({
      secret: "leave-unchanged",
    });
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
});
