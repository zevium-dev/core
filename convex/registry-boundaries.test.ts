/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { draftFingerprint } from "./publishReadiness";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Boundary API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: { "/ping": { get: { "x-zevium-cost": 1 } } },
});
const TRANSPORT_KEYRING = JSON.stringify({
  current: "transport-v1",
  keys: { "transport-v1": "33".repeat(32) },
});
const priorTransport = process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING;

beforeEach(() => {
  process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING = TRANSPORT_KEYRING;
});

afterEach(() => {
  if (priorTransport === undefined) {
    delete process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING;
  } else {
    process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING = priorTransport;
  }
});

type Seed = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  versionId: Id<"specVersions">;
  draftProjectId: Id<"projects">;
};

async function seed(t: ReturnType<typeof convexTest>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_boundary",
      name: "Boundary Publisher",
      slug: "boundary-publisher",
      publicHandle: "boundary-publisher",
    });
    await ctx.db.insert("wallets", {
      organizationId,
      balance: 100,
      sequence: 3,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Published API",
      slug: "published-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId,
      draft: SPEC,
      lastSavedAt: 1,
    });
    const versionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: SPEC,
      publishedAt: 1,
    });
    const draftProjectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Draft API",
      slug: "draft-api",
      status: "draft",
      visibility: "private",
      tags: [],
    });
    await ctx.db.insert("specs", {
      projectId: draftProjectId,
      draft: SPEC,
      lastSavedAt: 1,
    });
    await ctx.db.insert("publishReadiness", {
      projectId: draftProjectId,
      draftHash: await draftFingerprint(SPEC),
      serverOrigin: "https://api.example.com",
      status: "ok",
      testedAt: Date.now(),
    });
    await ctx.db.insert("keySettings", {
      clerkOrgId: "org_boundary",
      keyId: "key_boundary",
      ownerUserId: "user_admin",
      disabled: false,
      updatedAt: 1,
    });
    return { organizationId, projectId, versionId, draftProjectId };
  });
}

function asRole(t: ReturnType<typeof convexTest>, role: string) {
  return t.withIdentity({
    subject: `user_${role}`,
    org_id: "org_boundary",
    org_slug: "boundary-publisher",
    org_role: role,
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("registry producer public boundaries", () => {
  it("does not deploy destructive dev seed or cleanup mutations", () => {
    expect(Object.keys(modules)).not.toContain("./dev.ts");
  });

  it("denies members every visibility/publish/deprecate/retire producer", async () => {
    const t = convexTest(schema, modules);
    const world = await seed(t);
    const member = asRole(t, "org:member");

    await expect(
      member.mutation(api.projects.update, {
        projectId: world.projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow("Org admin role required");
    await expect(
      member.mutation(api.specs.publish, {
        projectId: world.draftProjectId,
        version: "1.0.0",
      }),
    ).rejects.toThrow("Org admin role required");
    await expect(
      member.mutation(api.specs.deprecateVersion, {
        versionId: world.versionId,
      }),
    ).rejects.toThrow("Org admin role required");
    await expect(
      member.mutation(api.projects.remove, { projectId: world.projectId }),
    ).rejects.toThrow("Org admin role required");

    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(world.projectId),
      version: await ctx.db.get(world.versionId),
      events: await ctx.db.query("registryOutbox").collect(),
    }));
    expect(state.project?.retiredAt).toBeUndefined();
    expect(state.version?.deprecatedAt).toBeUndefined();
    expect(state.events).toHaveLength(0);
  });

  it.each(["org:admin", "org:owner"])(
    "allows %s visibility lifecycle authority",
    async (role) => {
      const t = convexTest(schema, modules);
      const world = await seed(t);
      await expect(
        asRole(t, role).mutation(api.projects.update, {
          projectId: world.draftProjectId,
          patch: { visibility: "public" },
        }),
      ).resolves.toMatchObject({ visibility: "public" });
    },
  );

  it("archives terminally, retains immutable state, and rejects slug/handle reuse", async () => {
    const t = convexTest(schema, modules);
    const world = await seed(t);
    const admin = asRole(t, "org:admin");

    await t.run(async (ctx) => {
      await ctx.db.patch(world.projectId, {
        deprecationStartedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        sunsetAt: Date.now() - 1,
        deprecationMessage: "Retired",
      });
    });
    const archived = await admin.mutation(api.projects.remove, {
      projectId: world.projectId,
    });
    const retained = await t.run(async (ctx) => ({
      project: await ctx.db.get(world.projectId),
      version: await ctx.db.get(world.versionId),
      tombstone: await ctx.db
        .query("publicRouteTombstones")
        .withIndex("by_project", (q) => q.eq("projectId", world.projectId))
        .unique(),
    }));
    expect(archived.archived).toBe(world.projectId);
    expect(retained.project?.retiredAt).toBe(archived.retiredAt);
    expect(retained.version?.spec).toBe(SPEC);
    expect(retained.tombstone).toMatchObject({
      publisherHandle: "boundary-publisher",
      projectSlug: "published-api",
      retiredAt: archived.retiredAt,
    });
    await expect(
      admin.mutation(api.projects.create, {
        orgSlug: "boundary-publisher",
        name: "Resurrection",
        slug: "published-api",
      }),
    ).rejects.toThrow(/already exists|permanently reserved/);

    await t.mutation(internal.organizations.deleteFromClerk, {
      clerkOrgId: "org_boundary",
    });
    const newcomer = t.withIdentity({
      subject: "user_new",
      org_id: "org_new",
      org_slug: "new-boundary-publisher",
      org_role: "org:owner",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    const newOrg = await newcomer.mutation(
      api.organizations.ensureOrganization,
      {
        clerkOrgId: "org_new",
      },
    );
    expect(newOrg.publicHandle).toBe("new-boundary-publisher");
    await expect(
      newcomer.mutation(api.organizations.setPublicHandle, {
        handle: "boundary-publisher",
      }),
    ).rejects.toThrow("already in use");
    await expect(
      newcomer.mutation(api.projects.create, {
        orgSlug: "new-boundary-publisher",
        name: "New Namespace API",
        slug: "new-namespace-api",
      }),
    ).resolves.toMatchObject({ slug: "new-namespace-api" });
  });

  it("fails every current public/execution lookup closed for archived orgs", async () => {
    const t = convexTest(schema, modules);
    const world = await seed(t);
    const embeddingId = await t.run(
      async (ctx) =>
        await ctx.db.insert("specEmbeddings", {
          projectId: world.projectId,
          text: "boundary",
          embedding: Array.from({ length: 768 }, () => 0),
          updatedAt: 1,
        }),
    );

    await t.mutation(internal.organizations.deleteFromClerk, {
      clerkOrgId: "org_boundary",
    });

    const [byHandle, catalogue, detail, published, internalPublished, search] =
      await Promise.all([
        t.query(api.organizations.getByPublicHandle, {
          handle: "boundary-publisher",
        }),
        t.query(api.catalogue.listPublic, {}),
        t.query(api.catalogue.getPublicDetail, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(api.specs.getPublishedForGateway, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(internal.specs.getPublishedForGatewayInternal, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(internal.search.fetchSearchListings, {
          ids: [embeddingId],
          scores: [1],
        }),
      ]);
    expect(byHandle).toBeNull();
    expect(catalogue).toMatchObject({ items: [], total: 0 });
    expect(detail).toBeNull();
    expect(published).toBeNull();
    expect(internalPublished).toBeNull();
    expect(search).toEqual([]);

    const wallet = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_boundary",
    });
    expect(wallet.archived).toBe(true);
    expect(wallet.wallet.balance).toBe(0);
    expect(wallet.keySettings).toEqual([
      expect.objectContaining({ keyId: "key_boundary", disabled: true }),
    ]);
  });

  it("treats tombstones as authority over restored active-looking rows", async () => {
    const t = convexTest(schema, modules);
    const world = await seed(t);
    const embeddingId = await t.run(async (ctx) => {
      await ctx.db.insert("publicRouteTombstones", {
        organizationId: world.organizationId,
        projectId: world.projectId,
        publisherHandle: "boundary-publisher",
        projectSlug: "published-api",
        reservedAt: 1,
      });
      await ctx.db.insert("organizationTombstones", {
        clerkOrgId: "org_boundary",
        sourceRevision: 1,
        archivedAt: 777,
      });
      return await ctx.db.insert("specEmbeddings", {
        projectId: world.projectId,
        text: "boundary",
        embedding: Array.from({ length: 768 }, () => 0),
        updatedAt: 1,
      });
    });

    const [byHandle, catalogue, detail, published, internalPublished, search] =
      await Promise.all([
        t.query(api.organizations.getByPublicHandle, {
          handle: "boundary-publisher",
        }),
        t.query(api.catalogue.listPublic, {}),
        t.query(api.catalogue.getPublicDetail, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(api.specs.getPublishedForGateway, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(internal.specs.getPublishedForGatewayInternal, {
          publisherHandle: "boundary-publisher",
          projectSlug: "published-api",
        }),
        t.query(internal.search.fetchSearchListings, {
          ids: [embeddingId],
          scores: [1],
        }),
      ]);
    expect(byHandle).toBeNull();
    expect(catalogue).toMatchObject({ items: [], total: 0 });
    expect(detail).toBeNull();
    expect(published).toBeNull();
    expect(internalPublished).toBeNull();
    expect(search).toEqual([]);

    const wallet = await t.query(internal.wallets.getGatewayWallet, {
      clerkOrgId: "org_boundary",
    });
    expect(wallet).toMatchObject({
      archived: true,
      wallet: { balance: 0 },
      keySettings: [expect.objectContaining({ disabled: true })],
    });

    await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: "org_boundary",
      name: "Boundary Publisher",
      slug: "boundary-publisher",
    });
    await expect(
      t.run(async (ctx) => ctx.db.get(world.organizationId)),
    ).resolves.toMatchObject({ archivedAt: 777 });
  });

  it("requires an exact active route tombstone binding", async () => {
    const t = convexTest(schema, modules);
    const world = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publicRouteTombstones", {
        organizationId: world.organizationId,
        projectId: world.projectId,
        publisherHandle: "boundary-publisher",
        projectSlug: "published-api",
        reservedAt: 1,
        retiredAt: 2,
      });
    });

    const [detail, published, internalPublished] = await Promise.all([
      t.query(api.catalogue.getPublicDetail, {
        publisherHandle: "boundary-publisher",
        projectSlug: "published-api",
      }),
      t.query(api.specs.getPublishedForGateway, {
        publisherHandle: "boundary-publisher",
        projectSlug: "published-api",
      }),
      t.query(internal.specs.getPublishedForGatewayInternal, {
        publisherHandle: "boundary-publisher",
        projectSlug: "published-api",
      }),
    ]);
    expect(detail).toBeNull();
    expect(published).toBeNull();
    expect(internalPublished).toBeNull();
  });

  it("binds organization mirror slug to signed active-org claims", async () => {
    const t = convexTest(schema, modules);
    const attacker = t.withIdentity({
      subject: "user_attacker",
      org_id: "org_attacker",
      org_slug: "attacker-real",
      org_role: "org:owner",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    const victim = t.withIdentity({
      subject: "user_victim",
      org_id: "org_victim",
      org_slug: "victim",
      org_role: "org:owner",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });

    const attackerOrg = await attacker.mutation(
      api.organizations.ensureOrganization,
      {
        clerkOrgId: "org_attacker",
      },
    );
    const victimOrg = await victim.mutation(
      api.organizations.ensureOrganization,
      {
        clerkOrgId: "org_victim",
      },
    );
    expect(attackerOrg.slug).toBe("attacker-real");
    expect(attackerOrg.publicHandle).toBe("attacker-real");
    expect(victimOrg.slug).toBe("victim");
    expect(victimOrg.publicHandle).toBe("victim");
    await expect(
      victim.mutation(api.projects.create, {
        orgSlug: "victim",
        name: "Victim API",
        slug: "victim-api",
      }),
    ).resolves.toMatchObject({ slug: "victim-api" });
  });
});
