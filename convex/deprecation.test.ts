/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_stranger",
      name: "Stranger Co",
      slug: "stranger-co",
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
    await expect(
      asStranger(t).mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
        message: "Use v2",
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      t.mutation(api.specs.deprecateVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("specs.deprecateVersion — metadata", () => {
  it("sets deprecatedAt, sunsetAt, deprecationMessage", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const sunsetAt = Date.now() + 86_400_000;

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
      sunsetAt: Date.now() + 1000,
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

  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await expect(
      asStranger(t).mutation(api.specs.undeprecateVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/Not a member/);
  });
});

describe("specs.getPublishedForGateway — deprecation metadata", () => {
  it("includes undefined deprecation fields on healthy version", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const result = await t.query(api.specs.getPublishedForGateway, {
      orgSlug: "pub-co",
      projectSlug: "dep-api",
    });

    expect(result).not.toBeNull();
    expect(result!.deprecatedAt).toBeUndefined();
    expect(result!.sunsetAt).toBeUndefined();
    expect(result!.deprecationMessage).toBeUndefined();
    expect(result!.version).toBe("1.0.0");
  });

  it("includes deprecation metadata after deprecate", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const sunsetAt = Date.now() + 86_400_000;

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      sunsetAt,
      message: "Sunsetting",
    });

    const result = await t.query(api.specs.getPublishedForGateway, {
      orgSlug: "pub-co",
      projectSlug: "dep-api",
    });

    expect(result).not.toBeNull();
    expect(result!.deprecatedAt).toBeGreaterThan(0);
    expect(result!.sunsetAt).toBe(sunsetAt);
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
      orgSlug: "pub-co",
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
      orgSlug: "pub-co",
      projectSlug: "dep-api",
    });
    expect(before!.latestVersion!.deprecatedAt).toBeUndefined();

    await asPublisher(t).mutation(api.specs.deprecateVersion, {
      versionId: seed.versionId,
      message: "EOL",
    });

    // After deprecation
    const after = await t.query(api.catalogue.getPublicDetail, {
      orgSlug: "pub-co",
      projectSlug: "dep-api",
    });
    expect(after!.latestVersion!.deprecatedAt).toBeGreaterThan(0);
    expect(after!.latestVersion!.deprecationMessage).toBe("EOL");
  });
});

describe("specs.publish — fires spec_published notification", () => {
  it("creates notification on successful publish", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);

    await asPublisher(t).mutation(api.specs.publish, {
      projectId: seed.projectId,
      version: "1.1.0",
    });

    const notifs = await t.run(async (ctx) => {
      return await ctx.db.query("notifications").collect();
    });
    const publishedNotif = notifs.find((n) => n.kind === "spec_published");
    expect(publishedNotif).toBeDefined();
    expect(publishedNotif!.title).toBe("Spec published");
    expect(publishedNotif!.refId).toMatch(/spec_published:/);
  });
});
