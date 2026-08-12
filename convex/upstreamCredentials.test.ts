/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_SECRET = "test-gateway-internal-secret";
const ADMIN = "security_admin";

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

async function seedProject(
  t: ReturnType<typeof convexTest>,
  visibility: "public" | "private" = "public",
) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
      publicHandle: "publisher",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Markdown to HTML",
      slug: "md-to-html",
      description: "Render markdown",
      status: "published",
      visibility,
      tags: ["markdown"],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: "{}",
      lastSavedAt: 1,
    });
    await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: '{"openapi":"3.1.0"}',
      publishedAt: 1,
    });
    return { projectId };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_publisher",
    org_id: "org_publisher",
    org_slug: "publisher",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asStranger(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_stranger",
    org_id: "org_stranger",
    org_slug: "stranger",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asMember(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_member",
    org_id: "org_publisher",
    org_slug: "publisher",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("upstream credentials", () => {
  const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;
  const previousEncryptionKey = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
  const previousAdminIds = process.env.ADMIN_USER_IDS;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = INTERNAL_SECRET;
    process.env.ADMIN_USER_IDS = ADMIN;
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: "test-v1",
      keys: {
        "test-v1": "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=",
      },
    });
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = previousSecret;
    }
    if (previousEncryptionKey === undefined) {
      delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
    } else {
      process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = previousEncryptionKey;
    }
    if (previousAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = previousAdminIds;
  });

  it("writes secret once and only returns metadata to publisher", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    const created = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "X-API-Key",
      secret: "publisher-secret",
    });
    expect(created.name).toBe("x-api-key");
    expect(created).not.toHaveProperty("secret");

    const rows = await publisher.query(api.upstreamCredentials.listForProject, {
      projectId,
    });
    expect(rows).toEqual([created]);

    const stored = await t.run(async (ctx) =>
      ctx.db.get(created.id as Id<"upstreamCredentials">),
    );
    expect(stored?.ciphertext).not.toContain("publisher-secret");
    expect(stored?.iv).toBeTruthy();
    expect(stored?.keyVersion).toBe("test-v1");
  });

  it("updates same header and gateway endpoint receives latest value", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    const first = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "x-api-key",
      secret: "first",
    });
    const second = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "X-API-KEY",
      secret: "second",
    });
    expect(second.id).toBe(first.id);

    const response = await t.fetch(
      "/gateway-spec?publisherHandle=publisher&projectSlug=md-to-html",
      { headers: { "x-internal-secret": INTERNAL_SECRET } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId,
      upstreamHeaders: { "x-api-key": "second" },
    });
  });

  it("returns private published projects to the gateway", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t, "private");

    const response = await t.fetch(
      "/gateway-spec?publisherHandle=publisher&projectSlug=md-to-html",
      { headers: { "x-internal-secret": INTERNAL_SECRET } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId,
      visibility: "private",
    });
  });

  it("rejects unauthorized reads and mutations", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await expect(
      asStranger(t).query(api.upstreamCredentials.listForProject, {
        projectId,
      }),
    ).rejects.toThrow(/Not a member of this organization/);
    await expect(
      asStranger(t).mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "x-api-key",
        secret: "stolen",
      }),
    ).rejects.toThrow(/Not a member of this organization/);
  });

  it("allows members to view metadata but reserves credential changes for admins", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    await expect(
      asMember(t).mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "x-api-key",
        secret: "stolen",
      }),
    ).rejects.toThrow(/Org admin role required/);
  });

  it("rejects unsafe headers and values", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);

    await expect(
      publisher.mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "host",
        secret: "example.com",
      }),
    ).rejects.toThrow(/cannot be configured/);
    await expect(
      publisher.mutation(api.upstreamCredentials.upsert, {
        projectId,
        name: "x-api-key",
        secret: "value\r\nx-injected: yes",
      }),
    ).rejects.toThrow(/newlines/);
  });

  it("removes configured credential", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);
    const created = await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "Bearer upstream",
    });

    await publisher.mutation(api.upstreamCredentials.remove, {
      credentialId: created.id,
    });
    expect(
      await publisher.query(api.upstreamCredentials.listForProject, {
        projectId,
      }),
    ).toEqual([]);
  });

  it("blocks migration after independent audit detects a mismatched hybrid", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const created = await asPublisher(t).mutation(
      api.upstreamCredentials.upsert,
      {
        projectId,
        name: "authorization",
        secret: "encrypted-value",
      },
    );
    const encryptedBefore = await t.run(async (ctx) => ctx.db.get(created.id));
    const legacyId = await t.run(async (ctx) => {
      await ctx.db.patch(created.id, { secret: "stale-plaintext-copy" });
      return await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-api-key",
        secret: "legacy-value",
        updatedAt: 1,
      });
    });

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
      zeroCorruption: false,
      corrupt: 1,
    });
    await expect(
      t.mutation(internal.upstreamCredentials.migrateLegacyPlaintext, {
        auditId: audit.auditId,
      }),
    ).rejects.toThrow("zero-corruption security audit");

    const rows = await t.run(async (ctx) => ({
      encrypted: await ctx.db.get(created.id),
      legacy: await ctx.db.get(legacyId),
    }));
    expect(rows.encrypted?.secret).toBe("stale-plaintext-copy");
    expect(rows.legacy?.secret).toBe("legacy-value");
    expect(rows.encrypted?.ciphertext).toBe(encryptedBefore?.ciphertext);
    expect(rows.encrypted?.sealedCiphertext).toBe(
      encryptedBefore?.sealedCiphertext,
    );
  });

  it("returns one non-enumerating error for missing and cross-org credential ids", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const owned = await asPublisher(t).mutation(
      api.upstreamCredentials.upsert,
      {
        projectId,
        name: "authorization",
        secret: "secret",
      },
    );
    const missing = await t.run(async (ctx) => {
      const id = await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-deleted",
        secret: "temporary",
        updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    for (const credentialId of [owned.id, missing]) {
      const caller = asStranger(t);
      await expect(
        caller.mutation(api.upstreamCredentials.remove, { credentialId }),
      ).rejects.toThrow("Upstream credential unavailable");
    }
  });

  it("rewraps in cursor-bounded pages before old key retirement", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seedProject(t);
    const publisher = asPublisher(t);
    await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "authorization",
      secret: "Bearer one",
    });
    await publisher.mutation(api.upstreamCredentials.upsert, {
      projectId,
      name: "x-api-key",
      secret: "two",
    });
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: "test-v2",
      keys: {
        "test-v1": "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=",
        "test-v2": "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI=",
      },
    });

    const auditId = await completeSecurityAudit(t);

    const first = await t.mutation(
      internal.upstreamCredentials.migrateLegacyPlaintext,
      { auditId, cursor: null, numItems: 1 },
    );
    expect(first).toMatchObject({
      scanned: 1,
      old: 1,
      rewrapped: 1,
      broken: 0,
      isDone: false,
    });
    const second = await t.mutation(
      internal.upstreamCredentials.migrateLegacyPlaintext,
      { auditId, cursor: first.continueCursor, numItems: 1 },
    );
    expect(second).toMatchObject({
      scanned: 1,
      old: 1,
      rewrapped: 1,
      broken: 0,
      isDone: true,
    });

    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
      current: "test-v2",
      keys: {
        "test-v2": "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI=",
      },
    });
    const response = await t.fetch(
      "/gateway-spec?publisherHandle=publisher&projectSlug=md-to-html",
      { headers: { "x-internal-secret": INTERNAL_SECRET } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      upstreamHeaders: {
        authorization: "Bearer one",
        "x-api-key": "two",
      },
    });
  });
});
