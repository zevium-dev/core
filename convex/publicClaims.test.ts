/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { draftFingerprint } from "./publishReadiness";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function specWithCopy(copy: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Claims test", version: "1.0.0", ...copy },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/ping": {
        get: { summary: "Ping", "x-zevium-cost": 1 },
      },
    },
  });
}

async function seed(t: ReturnType<typeof convexTest>): Promise<{
  projectId: Id<"projects">;
}> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_claims",
      name: "Claims Test Org",
      slug: "claims-test",
      publicHandle: "claims-test",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Claims Test API",
      slug: "claims-api",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: specWithCopy({}),
      lastSavedAt: Date.now(),
    });
    return { projectId };
  });
}

function asAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_claims",
    org_id: "org_claims",
    org_slug: "claims-test",
    org_role: "org:admin",
  });
}

describe("publisher public-claim boundaries", () => {
  it("rejects Clerk sync, explicit handle, and unsafe backfill writes", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const admin = asAdmin(t);

    await expect(
      admin.mutation(api.organizations.ensureOrganization, {
        clerkOrgId: "org_claims",
        name: "Claims Test Org",
        slug: "ccpa-compliant",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
    await expect(
      t.mutation(internal.organizations.upsertFromClerk, {
        clerkOrgId: "org_clerk_bad_copy",
        name: "G.D.P.R compliant",
        slug: "clerk-bad-copy",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
    await expect(
      admin.mutation(api.organizations.setPublicHandle, {
        handle: "hipaa-compliant",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);

    const legacyId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        clerkOrgId: "org_legacy_bad_copy",
        name: "Legacy",
        slug: "iso-27001-certified",
      }),
    );
    const backfill = await t.mutation(
      internal.organizations.backfillPublicHandles,
      {},
    );
    expect(backfill.blocked).toBe(1);
    const legacy = await t.run((ctx) => ctx.db.get(legacyId));
    expect(legacy?.publicHandle).toBeUndefined();
  });

  it("rejects project name, description, and tag writes", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);

    await expect(
      admin.mutation(api.projects.create, {
        orgSlug: "claims-test",
        name: "SOC​2 certified",
        slug: "blocked-name",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
    await expect(
      admin.mutation(api.projects.create, {
        orgSlug: "claims-test",
        name: "Blocked slug",
        slug: "hipaa-ready",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);

    await expect(
      admin.mutation(api.projects.update, {
        projectId,
        patch: { description: "bank-grade encryption" },
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);

    await expect(
      admin.mutation(api.projects.update, {
        projectId,
        patch: { tags: ["fully-secure"] },
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
  });

  it("rejects OpenAPI-derived copy on save", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const result = await asAdmin(t).mutation(api.specs.saveDraft, {
      projectId,
      spec: specWithCopy({ description: "GDPR: compliant" }),
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          path: "$.info.description",
          message: expect.stringMatching(/Unsupported public claim/),
        }),
      ]),
    );
  });

  it("rechecks bypassed legacy copy at publish and make-public boundaries", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const badSpec = specWithCopy({ description: "zero data retention" });

    await t.run(async (ctx) => {
      const draft = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .unique();
      if (draft === null) throw new Error("missing draft");
      await ctx.db.patch(draft._id, {
        draft: badSpec,
        lastSavedAt: Date.now(),
      });
      await ctx.db.insert("publishReadiness", {
        projectId,
        draftHash: await draftFingerprint(badSpec),
        serverOrigin: "https://api.example.com",
        credentialRevision: 0,
        status: "ok",
        testedAt: Date.now(),
      });
    });

    const publish = await asAdmin(t).mutation(api.specs.publish, {
      projectId,
      version: "1.0.0",
    });
    expect(publish.ok).toBe(false);
    expect(
      publish.issues.some((issue) => issue.path === "$.info.description"),
    ).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("specVersions", {
        projectId,
        version: "0.9.0",
        spec: badSpec,
        publishedAt: Date.now(),
      });
      await ctx.db.patch(projectId, { status: "published" });
    });
    await expect(
      asAdmin(t).mutation(api.projects.update, {
        projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow(/public policy/i);
  });

  it("fails closed on public catalogue rows inserted outside mutations", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, {
        name: "enterprise-grade platform",
        status: "published",
        visibility: "public",
      });
      await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: specWithCopy({}),
        publishedAt: Date.now(),
      });
    });

    const list = await t.query(api.catalogue.listPublic, {});
    expect(list.items).toEqual([]);
    await expect(
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "claims-test",
        projectSlug: "claims-api",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "claims-test",
        projectSlug: "claims-api",
      }),
    ).resolves.toBeNull();

    const embeddingId = await t.run(async (ctx) =>
      ctx.db.insert("specEmbeddings", {
        projectId,
        text: "legacy unsafe",
        embedding: Array.from({ length: 768 }, () => 0.1),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      t.query(internal.search.fetchSearchListings, {
        ids: [embeddingId],
        scores: [0.9],
      }),
    ).resolves.toEqual([]);
  });

  it("fails closed on unsafe legacy organization while preserving private remediation", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    await t.run(async (ctx) => {
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", "org_claims"))
        .unique();
      if (organization === null) throw new Error("missing organization");
      await ctx.db.patch(organization._id, { name: "SOC.2 certified" });
      await ctx.db.patch(projectId, {
        status: "published",
        visibility: "public",
      });
      await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: specWithCopy({}),
        publishedAt: Date.now(),
      });
    });

    await expect(
      t.query(api.organizations.getByPublicHandle, { handle: "claims-test" }),
    ).resolves.toBeNull();
    await expect(t.query(api.catalogue.listPublic, {})).resolves.toMatchObject({
      items: [],
    });
    await expect(
      t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "claims-test",
        projectSlug: "claims-api",
      }),
    ).resolves.toBeNull();

    const mine = await asAdmin(t).query(api.organizations.listMine, {});
    expect(mine).toHaveLength(1);
    const privateProject = await asAdmin(t).query(api.projects.get, {
      orgSlug: "claims-test",
      projectSlug: "claims-api",
    });
    expect(privateProject?._id).toBe(projectId);
  });

  it("lets an owner hide unsafe legacy project copy before repairing it", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, {
        name: "HIPAA ready legacy project",
        visibility: "public",
      });
    });

    await expect(
      asAdmin(t).mutation(api.projects.update, {
        projectId,
        patch: { visibility: "private" },
      }),
    ).resolves.toMatchObject({ visibility: "private" });

    await expect(
      asAdmin(t).mutation(api.projects.update, {
        projectId,
        patch: {
          description: "SOC.2 certified",
          visibility: "private",
        },
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
  });

  it("admin visibility write cannot expose unsafe legacy rows", async () => {
    const prior = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = "platform_admin";
    try {
      const t = convexTest(schema, modules);
      const { projectId } = await seed(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(projectId, { status: "published" });
        await ctx.db.insert("specVersions", {
          projectId,
          version: "1.0.0",
          spec: specWithCopy({ version: "HIPAA ready" }),
          publishedAt: Date.now(),
        });
      });
      const platformAdmin = t.withIdentity({ subject: "platform_admin" });
      await expect(
        platformAdmin.mutation(api.admin.setProjectVisibility, {
          projectId,
          visibility: "public",
        }),
      ).rejects.toThrow(/public policy/i);
      await expect(
        platformAdmin.mutation(api.admin.setProjectVisibility, {
          projectId,
          visibility: "private",
        }),
      ).resolves.toMatchObject({ visibility: "private" });
    } finally {
      if (prior === undefined) delete process.env.ADMIN_USER_IDS;
      else process.env.ADMIN_USER_IDS = prior;
    }
  });

  it("direct public spec, catalogue, and search reads reject malformed JSON", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const embeddingId = await t.run(async (ctx) => {
      await ctx.db.patch(projectId, {
        status: "published",
        visibility: "public",
      });
      await ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: "{malformed",
        publishedAt: Date.now(),
      });
      return await ctx.db.insert("specEmbeddings", {
        projectId,
        text: "malformed",
        embedding: Array.from({ length: 768 }, () => 0.1),
        updatedAt: Date.now(),
      });
    });

    const route = {
      publisherHandle: "claims-test",
      projectSlug: "claims-api",
    };
    await expect(
      t.query(api.specs.getPublishedForGateway, route),
    ).resolves.toBeNull();
    await expect(
      t.query(api.catalogue.getPublicDetail, route),
    ).resolves.toBeNull();
    await expect(t.query(api.catalogue.listPublic, {})).resolves.toMatchObject({
      items: [],
    });
    await expect(
      t.query(internal.search.fetchSearchListings, {
        ids: [embeddingId],
        scores: [1],
      }),
    ).resolves.toEqual([]);
  });

  it("rejects unsafe public deprecation copy", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const versionId = await t.run(async (ctx) =>
      ctx.db.insert("specVersions", {
        projectId,
        version: "1.0.0",
        spec: specWithCopy({}),
        publishedAt: Date.now(),
      }),
    );

    await expect(
      asAdmin(t).mutation(api.specs.deprecateVersion, {
        versionId,
        message: "secure against every breach",
      }),
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
  });
});
