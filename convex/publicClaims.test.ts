/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
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
  it("rejects project name, description, and tag writes", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await seed(t);
    const admin = asAdmin(t);

    await expect(
      admin.mutation(api.projects.create, {
        orgSlug: "claims-test",
        name: "SOC​2",
        slug: "blocked-name",
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
    ).rejects.toThrow(/unsupported compliance or absolute security claim/i);
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
