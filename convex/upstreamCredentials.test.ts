/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { decryptCredential } from "./lib/credentialCrypto";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const INTERNAL_SECRET = "test-gateway-internal-secret";

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

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = INTERNAL_SECRET;
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

  it("repairs mismatched hybrid ciphertext before scrubbing recoverable plaintext", async () => {
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
    const legacyId = await t.run(async (ctx) => {
      await ctx.db.patch(created.id, { secret: "stale-plaintext-copy" });
      return await ctx.db.insert("upstreamCredentials", {
        projectId,
        name: "x-api-key",
        secret: "legacy-value",
        updatedAt: 1,
      });
    });

    const migration = await t.mutation(
      internal.upstreamCredentials.migrateLegacyPlaintext,
      {},
    );
    expect(migration).toMatchObject({
      scanned: 2,
      current: 2,
      broken: 0,
      corrupt: 1,
      recovered: 1,
      plaintext: 2,
      scrubbed: 2,
      isDone: true,
    });

    const rows = await t.run(async (ctx) => ({
      encrypted: await ctx.db.get(created.id),
      legacy: await ctx.db.get(legacyId),
    }));
    expect(rows.encrypted?.secret).toBeUndefined();
    expect(rows.legacy?.secret).toBeUndefined();
    expect(await decryptCredential(rows.legacy!, projectId, "x-api-key")).toBe(
      "legacy-value",
    );
    expect(
      await decryptCredential(rows.encrypted!, projectId, "authorization"),
    ).toBe("stale-plaintext-copy");
    expect(
      await t.mutation(internal.upstreamCredentials.migrateLegacyPlaintext, {}),
    ).toMatchObject({
      scanned: 2,
      current: 2,
      old: 0,
      broken: 0,
      plaintext: 0,
      scrubbed: 0,
      isDone: true,
    });
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

    const first = await t.mutation(
      internal.upstreamCredentials.migrateLegacyPlaintext,
      { cursor: null, numItems: 1 },
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
      { cursor: first.continueCursor, numItems: 1 },
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
