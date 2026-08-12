/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptCredential } from "./lib/credentialCrypto";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  projectId: Id<"projects">;
  specId: Id<"specs">;
  versionId: Id<"specVersions">;
  credentialId: Id<"upstreamCredentials">;
  readinessId: Id<"publishReadiness">;
  embeddingId: Id<"specEmbeddings">;
  endpointId: Id<"webhookEndpoints">;
  deliveryId: Id<"webhookDeliveries">;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_pub",
      name: "Publisher",
      slug: "publisher",
      publicHandle: "publisher",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
      publicHandle: "other",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Original API",
      slug: "original-api",
      description: "Original description",
      status: "published",
      visibility: "private",
      tags: ["original"],
    });
    const specId = await ctx.db.insert("specs", {
      projectId,
      draft: "",
      lastSavedAt: 1,
    });
    const versionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: '{"openapi":"3.1.0"}',
      publishedAt: 1,
    });
    const credentialId = await ctx.db.insert("upstreamCredentials", {
      projectId,
      name: "Authorization",
      ...(await encryptCredential(
        "Bearer test-secret",
        projectId,
        "Authorization",
      )),
      updatedAt: 1,
    });
    const readinessId = await ctx.db.insert("publishReadiness", {
      projectId,
      draftHash: "draft",
      serverOrigin: "https://api.example.com",
      credentialRevision: 1,
      status: "ok",
      testedAt: 1,
    });
    const embeddingId = await ctx.db.insert("specEmbeddings", {
      projectId,
      text: "search text",
      embedding: Array.from({ length: 768 }, () => 0.1),
      updatedAt: 1,
    });
    const endpointId = await ctx.db.insert("webhookEndpoints", {
      projectId,
      url: "https://hooks.example.com/zevium",
      ciphertext: "encrypted-secret",
      iv: "encrypted-iv",
      keyVersion: "v1",
      active: true,
      createdAt: 1,
    });
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      endpointId,
      event: "spec.published",
      status: "pending",
      attempts: 0,
      payload: "{}",
      createdAt: 1,
    });
    return {
      projectId,
      specId,
      versionId,
      credentialId,
      readinessId,
      embeddingId,
      endpointId,
      deliveryId,
    };
  });
}

function asAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_admin",
    org_id: "org_pub",
    org_slug: "publisher",
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
    org_id: "org_pub",
    org_slug: "publisher",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asCrossOrgAdmin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_other_admin",
    org_id: "org_other",
    org_slug: "other",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("project lifecycle authorization", () => {
  it("lets admins create canonical private projects and draft rows", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const created = await asAdmin(t).mutation(api.projects.create, {
      orgSlug: "publisher",
      name: " New API ",
      slug: "new-api",
      description: " New description ",
    });

    expect(created).toMatchObject({
      name: "New API",
      slug: "new-api",
      description: "New description",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    const draft = await t.run(async (ctx) =>
      ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", created._id))
        .unique(),
    );
    expect(draft?.draft).toBe("");
  });

  it("rejects member create before validation or writes", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const before = await t.run(async (ctx) => ({
      projects: await ctx.db.query("projects").collect(),
      specs: await ctx.db.query("specs").collect(),
    }));

    await expect(
      asMember(t).mutation(api.projects.create, {
        orgSlug: "publisher",
        name: "",
        slug: "INVALID",
      }),
    ).rejects.toThrow(/Org admin or owner role required/);

    const after = await t.run(async (ctx) => ({
      projects: await ctx.db.query("projects").collect(),
      specs: await ctx.db.query("specs").collect(),
    }));
    expect(after).toEqual(before);
  });

  it("scopes project creation to the caller's signed org, ignoring the slug argument", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    const created = await asCrossOrgAdmin(t).mutation(api.projects.create, {
      orgSlug: "publisher",
      name: "Probe",
      slug: "probe",
    });
    const seedProject = await t.run(async (ctx) => ctx.db.get(seed.projectId));
    expect(created.organizationId).not.toBe(seedProject?.organizationId);
    const foreignProbe = await t.run(async (ctx) =>
      ctx.db
        .query("projects")
        .withIndex("by_org_slug", (q) =>
          q
            .eq("organizationId", seedProject!.organizationId)
            .eq("slug", "probe"),
        )
        .unique(),
    );
    expect(foreignProbe).toBeNull();
  });

  it("rejects member and cross-org updates with no state change", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const before = await t.run(async (ctx) => ctx.db.get(seed.projectId));

    await expect(
      asMember(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { name: "Member edit", visibility: "public" },
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
    await expect(
      asCrossOrgAdmin(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { name: "Cross-org edit", visibility: "public" },
      }),
    ).rejects.toThrow(/Not a member of this organization/);

    expect(await t.run(async (ctx) => ctx.db.get(seed.projectId))).toEqual(
      before,
    );
  });

  it("lets admins update metadata and catalogue visibility", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    const updated = await asAdmin(t).mutation(api.projects.update, {
      projectId: seed.projectId,
      patch: {
        name: "Updated API",
        description: "Updated description",
        visibility: "public",
        tags: [" Billing ", "billing", "AI"],
      },
    });

    expect(updated).toMatchObject({
      name: "Updated API",
      description: "Updated description",
      visibility: "public",
      tags: ["billing", "ai"],
    });
  });

  it("keeps member draft collaboration while blocking lifecycle writes", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const spec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Member Draft", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {},
    });

    const result = await asMember(t).mutation(api.specs.saveDraft, {
      projectId: seed.projectId,
      spec,
    });

    expect(result.ok).toBe(true);
    expect(result.draft).toBe(spec);
    await expect(
      asMember(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
  });

  it("rejects member and cross-org deletes without orphaning state", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    await expect(
      asMember(t).mutation(api.projects.remove, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Org admin or owner role required/);
    await expect(
      asCrossOrgAdmin(t).mutation(api.projects.remove, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/Not a member of this organization/);

    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(seed.projectId),
      spec: await ctx.db.get(seed.specId),
      version: await ctx.db.get(seed.versionId),
      credential: await ctx.db.get(seed.credentialId),
      readiness: await ctx.db.get(seed.readinessId),
      embedding: await ctx.db.get(seed.embeddingId),
      endpoint: await ctx.db.get(seed.endpointId),
      delivery: await ctx.db.get(seed.deliveryId),
    }));
    expect(state.project).not.toBeNull();
    expect(state.spec).not.toBeNull();
    expect(state.version).not.toBeNull();
    expect(state.credential).not.toBeNull();
    expect(state.readiness).not.toBeNull();
    expect(state.embedding).not.toBeNull();
    expect(state.endpoint).not.toBeNull();
    expect(state.delivery).not.toBeNull();
  });

  it("lets admins archive project-owned mutable state", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.projectId, { sunsetAt: Date.now() - 1 });
    });

    expect(
      await asAdmin(t).mutation(api.projects.remove, {
        projectId: seed.projectId,
      }),
    ).toEqual({ archived: seed.projectId, retiredAt: expect.any(Number) });

    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(seed.projectId),
      spec: await ctx.db.get(seed.specId),
      version: await ctx.db.get(seed.versionId),
      credential: await ctx.db.get(seed.credentialId),
      readiness: await ctx.db.get(seed.readinessId),
      embedding: await ctx.db.get(seed.embeddingId),
      endpoint: await ctx.db.get(seed.endpointId),
      delivery: await ctx.db.get(seed.deliveryId),
      cleanupJob: await ctx.db
        .query("projectCleanupJobs")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .unique(),
    }));
    expect(state.project).toMatchObject({
      retirementState: "retired",
      deletionState: "tombstoned",
    });
    expect(state.spec).toBeNull();
    // Published versions stay immutable history.
    expect(state.version).not.toBeNull();
    expect(state.credential).not.toBeNull();
    expect(state.readiness).toBeNull();
    expect(state.embedding).toBeNull();
    expect(state.endpoint).toMatchObject({ active: false });
    expect(state.delivery).not.toBeNull();
    expect(state.cleanupJob).toMatchObject({ phase: "credentials" });
  });
});
