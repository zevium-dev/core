/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { draftFingerprint } from "./publishReadiness";
import { MIN_DEPRECATION_NOTICE_MS } from "./projects";

const modules = import.meta.glob("./**/*.ts");

const SPEC_BODY = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/ping": {
      get: { "x-zevium-cost": 1, summary: "Ping" },
    },
  },
});

type Seeded = {
  orgId: Id<"organizations">;
  projectId: Id<"projects">;
  versionId: Id<"specVersions">;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_pub",
      name: "Pub Co",
      slug: "pub-co",
      publicHandle: "pub-co",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_stranger",
      name: "Stranger Co",
      slug: "stranger-co",
      publicHandle: "stranger-co",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Dep API",
      slug: "dep-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    // Spec draft needed for publish
    await ctx.db.insert("specs", {
      projectId,
      draft: SPEC_BODY,
      lastSavedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: SPEC_BODY,
      publishedAt: Date.now(),
    });
    await ctx.db.insert("publicRouteTombstones", {
      organizationId: orgId,
      projectId,
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
      reservedAt: Date.now(),
    });
    return { orgId, projectId, versionId };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_pub",
    org_id: "org_pub",
    org_slug: "pub-co",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asPublisherMember(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_pub_member",
    org_id: "org_pub",
    org_slug: "pub-co",
    org_role: "org:member",
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
    org_slug: "stranger-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("specs.deprecateVersion — auth", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishReadiness", {
        projectId: seed.projectId,
        draftHash: await draftFingerprint(SPEC_BODY),
        serverOrigin: "https://api.example.com",
        status: "ok",
        testedAt: Date.now(),
      });
    });
    await expect(
      asStranger(t).mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        message: "Use v2",
      }),
    ).rejects.toThrow(/Version not found/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      t.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        message: "Use v2",
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("rejects an ordinary member of the owning organization", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asPublisherMember(t).mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        message: "Use v2",
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      asPublisherMember(t).mutation(api.specs.undeprecateVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      asPublisherMember(t).mutation(api.specs.publish, {
        projectId: seed.projectId,
        version: "2.0.0",
      }),
    ).rejects.toThrow(/admin/);
  });
});

describe("specs.deprecateVersion — metadata", () => {
  it("sets deprecatedAt, sunsetAt, deprecationMessage", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const sunsetAt = Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000;

    const updated = await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      sunsetAt,
      message: "Use v2.0.0",
    });

    expect(updated.deprecatedAt).toBeGreaterThan(0);
    expect(updated.sunsetAt).toBe(sunsetAt);
    expect(updated.deprecationMessage).toBe("Use v2.0.0");
    // Spec body immutable
    expect(updated.spec).toBe(SPEC_BODY);
    expect(updated.version).toBe("1.0.0");
  });

  it("rejects unsafe, short-notice, and empty metadata without side effects", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const actor = asPublisher(t);

    await expect(
      actor.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS - 1,
        message: "Use v2",
      }),
    ).rejects.toThrow(/at least 7 days/);
    await expect(
      actor.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        sunsetAt: 1.5,
        message: "Use v2",
      }),
    ).rejects.toThrow(/safe timestamp/);
    await expect(
      actor.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        sunsetAt: Number.MAX_SAFE_INTEGER,
        message: "Use v2",
      }),
    ).rejects.toThrow(/safe timestamp/);
    await expect(
      actor.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        message: "   ",
      }),
    ).rejects.toThrow(/1 to 1000/);

    const unchanged = await t.run(async (ctx) => ctx.db.get(seed.versionId));
    expect(unchanged?.deprecatedAt).toBeUndefined();
    expect(
      await t.run(async (ctx) => ctx.db.query("notifications").collect()),
    ).toHaveLength(0);
  });

  it("fires version_deprecated notification", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      message: "Deprecated",
    });

    const notifs = await t.run(async (ctx) => {
      return await ctx.db.query("notifications").collect();
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.kind).toBe("version_deprecated");
    expect(notifs[0]!.refId).toBe(`version_deprecated:${seed.versionId}`);
  });
});

describe("specs.undeprecateVersion", () => {
  it("clears all deprecation metadata", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const as = asPublisher(t);

    await as.mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      message: "Temporarily deprecated",
      sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000,
    });

    const cleared = await as.mutation(api.specs.undeprecateVersion, {
      versionId: seed.versionId,
    });

    expect(cleared.deprecatedAt).toBeUndefined();
    expect(cleared.sunsetAt).toBeUndefined();
    expect(cleared.deprecationMessage).toBeUndefined();
    // Spec body still intact
    expect(cleared.spec).toBe(SPEC_BODY);
    expect(cleared.version).toBe("1.0.0");
  });

  it("cannot restore a version after its cutoff", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.versionId, {
        deprecatedAt: Date.now() - MIN_DEPRECATION_NOTICE_MS,
        sunsetAt: Date.now() - 1,
        deprecationMessage: "Cut off",
      });
    });
    await expect(
      asPublisher(t).mutation(api.specs.undeprecateVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/cannot be restored/);
    await expect(
      asPublisher(t).mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000,
        message: "Try to move cutoff",
      }),
    ).rejects.toThrow(/cannot be changed/);
    const unchanged = await t.run(async (ctx) => ctx.db.get(seed.versionId));
    expect(unchanged?.sunsetAt).toEqual(expect.any(Number));
  });

  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asStranger(t).mutation(api.specs.undeprecateVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/Version not found/);
  });
});

describe("specs.getPublishedForGateway — deprecation metadata", () => {
  it("includes undefined deprecation fields on healthy version", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await t.query(api.specs.getPublishedForGateway, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });

    expect(result).not.toBeNull();
    expect(result!.deprecatedAt).toBeUndefined();
    expect(result!.sunsetAt).toBeUndefined();
    expect(result!.deprecationMessage).toBeUndefined();
    expect(result!.version).toBe("1.0.0");
    expect(result).not.toHaveProperty("projectId");
    expect(result).not.toHaveProperty("organizationId");
    expect(result).not.toHaveProperty("clerkOrgId");
  });

  it("keeps version sunset informational until project retirement", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const sunsetAt = Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000;

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      sunsetAt,
      message: "Sunsetting",
    });

    const result = await t.query(api.specs.getPublishedForGateway, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });

    expect(result).not.toBeNull();
    expect(result!.deprecatedAt).toBeGreaterThan(0);
    expect(result!.sunsetAt).toBeUndefined();
    expect(result!.deprecationMessage).toBe("Sunsetting");
  });

  it("spec body unchanged after deprecation (immutability)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      message: "x",
    });

    const result = await t.query(api.specs.getPublishedForGateway, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });
    expect(result!.spec).toBe(SPEC_BODY);
  });
});

describe("catalogue.getPublicDetail — deprecation metadata", () => {
  it("includes deprecation fields in latestVersion", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    // Before deprecation
    const before = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });
    expect(before!.latestVersion!.deprecatedAt).toBeUndefined();

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      message: "EOL",
    });

    // After deprecation
    const after = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });
    expect(after!.latestVersion!.deprecatedAt).toBeGreaterThan(0);
    expect(after!.latestVersion!.deprecationMessage).toBe("EOL");
  });
});

describe("specs.publish — fires spec_published notification", () => {
  it("rejects member publication and public-visibility changes", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishReadiness", {
        projectId: seed.projectId,
        draftHash: await draftFingerprint(SPEC_BODY),
        serverOrigin: "https://api.example.com",
        status: "ok",
        testedAt: Date.now(),
      });
      await ctx.db.patch(seed.projectId, { visibility: "private" });
    });

    await expect(
      asPublisherMember(t).mutation(api.specs.publish, {
        projectId: seed.projectId,
        version: "1.1.0",
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      asPublisherMember(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      asPublisherMember(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { name: "Member-edited metadata" },
      }),
    ).resolves.toMatchObject({ name: "Member-edited metadata" });

    const published = await t.run(async (ctx) =>
      ctx.db
        .query("specVersions")
        .withIndex("by_project_version", (q) =>
          q.eq("projectId", seed.projectId).eq("version", "1.1.0"),
        )
        .unique(),
    );
    expect(published).toBeNull();
  });

  it("creates notification on successful publish", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("publishReadiness", {
        projectId: seed.projectId,
        draftHash: await draftFingerprint(SPEC_BODY),
        serverOrigin: "https://api.example.com",
        status: "ok",
        testedAt: Date.now(),
      });
    });
    const previousApiKey = process.env.GEMINI_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      Response.json({
        embedding: { values: Array.from({ length: 768 }, () => 0.1) },
      })) as typeof fetch;

    try {
      await asPublisher(t).mutation(api.specs.publish, {
        projectId: seed.projectId,
        version: "1.1.0",
      });
      await t.finishInProgressScheduledFunctions();

      const notifs = await t.run(async (ctx) => {
        return await ctx.db.query("notifications").collect();
      });
      const publishedNotif = notifs.find((n) => n.kind === "spec_published");
      expect(publishedNotif).toBeDefined();
      expect(publishedNotif!.title).toBe("Spec published");
      expect(publishedNotif!.refId).toMatch(/spec_published:/);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousApiKey;
      }
      globalThis.fetch = previousFetch;
    }
  });
});

describe("specs.publish — gateway-safe pricing invariant", () => {
  it.each([
    ["fractional cost", '"x-zevium-cost":1.5'],
    ["unsafe cost", `"x-zevium-cost":${Number.MAX_SAFE_INTEGER + 1}`],
    ["cost above ceiling", '"x-zevium-cost":1000001'],
    ["overflow cost", '"x-zevium-cost":1e309'],
    ["fractional free tier", '"x-zevium-cost":1,"x-zevium-free-tier":0.5'],
    ["negative free tier", '"x-zevium-cost":1,"x-zevium-free-tier":-1'],
  ])("never persists %s", async (_label, pricingFields) => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const unsafeSpec = SPEC_BODY.replace('"x-zevium-cost":1', pricingFields);
    await t.run(async (ctx) => {
      const draft = await ctx.db
        .query("specs")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .unique();
      if (draft === null) throw new Error("draft missing");
      await ctx.db.patch(draft._id, { draft: unsafeSpec });
      await ctx.db.insert("publishReadiness", {
        projectId: seed.projectId,
        draftHash: await draftFingerprint(unsafeSpec),
        serverOrigin: "https://api.example.com",
        status: "ok",
        testedAt: Date.now(),
      });
    });

    const result = await asPublisher(t).mutation(api.specs.publish, {
      projectId: seed.projectId,
      version: "9.9.9",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.level === "error")).toEqual([
      expect.objectContaining({ level: "error" }),
    ]);
    const persisted = await t.run(async (ctx) =>
      ctx.db
        .query("specVersions")
        .withIndex("by_project_version", (q) =>
          q.eq("projectId", seed.projectId).eq("version", "9.9.9"),
        )
        .unique(),
    );
    expect(persisted).toBeNull();
  });
});

describe("project retirement lifecycle", () => {
  it("requires admin, a message, and full mandatory notice window", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const member = t.withIdentity({
      subject: "user_member",
      org_id: "org_pub",
      org_slug: "pub-co",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      member.mutation(api.projects.scheduleRetirement, {
        projectId: seed.projectId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000,
        message: "Use replacement",
      }),
    ).rejects.toThrow(/admin/);
    await expect(
      asPublisher(t).mutation(api.projects.scheduleRetirement, {
        projectId: seed.projectId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS - 1,
        message: "Use replacement",
      }),
    ).rejects.toThrow(/at least 7 days/);
    await expect(
      asPublisher(t).mutation(api.projects.scheduleRetirement, {
        projectId: seed.projectId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000,
        message: "   ",
      }),
    ).rejects.toThrow(/message/);
    await expect(
      asPublisher(t).mutation(api.projects.scheduleRetirement, {
        projectId: seed.projectId,
        sunsetAt: Number.MAX_SAFE_INTEGER,
        message: "Use replacement",
      }),
    ).rejects.toThrow(/at least 7 days/);
    await expect(
      asPublisher(t).mutation(api.projects.scheduleRetirement, {
        projectId: seed.projectId,
        sunsetAt: Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000,
        message: "x".repeat(1001),
      }),
    ).rejects.toThrow(/message/);
    const unchanged = await t.run(async (ctx) => ({
      project: await ctx.db.get(seed.projectId),
      notifications: await ctx.db.query("notifications").collect(),
    }));
    expect(unchanged.project?.sunsetAt).toBeUndefined();
    expect(unchanged.project?.retirementState).toBeUndefined();
    expect(unchanged.notifications).toHaveLength(0);
  });

  it("freezes discovery but keeps detail and gateway state available until sunset", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const sunsetAt = Date.now() + MIN_DEPRECATION_NOTICE_MS + 60_000;
    const scheduled = await asPublisher(t).mutation(
      api.projects.scheduleRetirement,
      {
        projectId: seed.projectId,
        sunsetAt,
        message: "Move to v2",
      },
    );
    expect(scheduled.deprecationStartedAt).toEqual(expect.any(Number));
    expect(scheduled.sunsetAt).toBe(sunsetAt);

    const catalogue = await t.query(api.catalogue.listPublic, {});
    expect(catalogue.items.map((item) => item.slug)).not.toContain("dep-api");
    const detail = await t.query(api.catalogue.getPublicDetail, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });
    expect(detail?.latestVersion).toMatchObject({
      sunsetAt,
      deprecationMessage: "Move to v2",
    });
    const gateway = await t.query(api.specs.getPublishedForGateway, {
      publisherHandle: "pub-co",
      projectSlug: "dep-api",
    });
    expect(gateway).toMatchObject({ sunsetAt, visibility: "public" });

    await expect(
      asPublisher(t).mutation(api.projects.update, {
        projectId: seed.projectId,
        patch: { visibility: "private" },
      }),
    ).rejects.toThrow(/deprecation notice/);
    await expect(
      asPublisher(t).mutation(api.projects.remove, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/before sunset/);
  });

  it("cleans runtime secrets after sunset while retaining audit history", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.projectId, {
        deprecationStartedAt: Date.now() - MIN_DEPRECATION_NOTICE_MS - 1,
        sunsetAt: Date.now() - 1,
        deprecationMessage: "Retired",
      });
      await ctx.db.insert("upstreamCredentials", {
        projectId: seed.projectId,
        name: "authorization",
        updatedAt: 1,
      });
      await ctx.db.insert("webhookEndpoints", {
        projectId: seed.projectId,
        url: "https://hooks.example.test/zevium",
        secret: "hook-secret",
        active: true,
        createdAt: 1,
      });
      await ctx.db.insert("usageEvents", {
        organizationId: seed.orgId,
        projectId: seed.projectId,
        endpoint: "/ping",
        method: "GET",
        credits: 1,
        status: 200,
        latencyMs: 1,
        keyId: "historical-key",
        at: 1,
      });
    });

    await expect(
      asPublisher(t).mutation(api.projects.cancelRetirement, {
        projectId: seed.projectId,
      }),
    ).rejects.toThrow(/after sunset/);

    await t.mutation(internal.projects.retireSunsetProjects, {});
    for (let step = 0; step < 20; step += 1) {
      const result = await t.mutation(internal.projects.runProjectCleanupPage, {
        projectId: seed.projectId,
      });
      if (result.phase === "finished") break;
    }
    const state = await t.run(async (ctx) => ({
      project: await ctx.db.get(seed.projectId),
      versions: await ctx.db
        .query("specVersions")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .collect(),
      usage: await ctx.db
        .query("usageEvents")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .collect(),
      credentials: await ctx.db
        .query("upstreamCredentials")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .collect(),
      webhook: await ctx.db
        .query("webhookEndpoints")
        .withIndex("by_project", (q) => q.eq("projectId", seed.projectId))
        .unique(),
    }));
    expect(state.project).toMatchObject({ visibility: "private" });
    expect(state.project?.retiredAt).toEqual(expect.any(Number));
    expect(state.versions).toHaveLength(1);
    expect(state.usage).toHaveLength(1);
    expect(state.credentials).toHaveLength(0);
    expect(state.webhook).toBeNull();
  });
});
