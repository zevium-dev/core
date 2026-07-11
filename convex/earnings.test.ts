/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  publisherOrgId: Id<"organizations">;
  consumerOrgId: Id<"organizations">;
  projectAId: Id<"projects">;
  projectBId: Id<"projects">;
  versionId: Id<"specVersions">;
  monthStart: number;
};

async function seedPublisherWorld(
  t: ReturnType<typeof convexTest>,
): Promise<Seeded> {
  const now = Date.now();
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const inMonth = monthStart + 2 * 24 * 60 * 60 * 1000;
  const prevMonth = monthStart - 10 * 24 * 60 * 60 * 1000;

  return await t.run(async (ctx) => {
    const publisherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher Co",
      slug: "publisher-co",
    });
    const consumerOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_consumer",
      name: "Consumer Co",
      slug: "consumer-co",
    });
    // Stranger org owns nothing related — used for auth rejection.
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_stranger",
      name: "Stranger Co",
      slug: "stranger-co",
    });

    const projectAId = await ctx.db.insert("projects", {
      organizationId: publisherOrgId,
      name: "Alpha API",
      slug: "alpha",
      status: "published",
      visibility: "public",
      tags: ["alpha"],
    });
    const projectBId = await ctx.db.insert("projects", {
      organizationId: publisherOrgId,
      name: "Beta API",
      slug: "beta",
      status: "published",
      visibility: "public",
      tags: [],
    });

    const versionId = await ctx.db.insert("specVersions", {
      projectId: projectAId,
      version: "1.0.0",
      spec: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Alpha", version: "1.0.0" },
        paths: {},
      }),
      publishedAt: inMonth,
    });

    // Project A: 100 credits this month + 200 prev month.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/a",
      method: "GET",
      credits: 100,
      status: 200,
      latencyMs: 10,
      keyId: "k1",
      at: inMonth,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/a",
      method: "GET",
      credits: 200,
      status: 200,
      latencyMs: 12,
      keyId: "k1",
      at: prevMonth,
    });
    // Project B: 40 credits this month only.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectBId,
      endpoint: "/b",
      method: "POST",
      credits: 40,
      status: 200,
      latencyMs: 20,
      keyId: "k2",
      at: inMonth + 1,
    });

    return {
      publisherOrgId,
      consumerOrgId,
      projectAId,
      projectBId,
      versionId,
      monthStart,
    };
  });
}

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "user_pub",
    org_id: "org_publisher",
    org_slug: "publisher-co",
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

describe("earnings.forOrg", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedPublisherWorld(t);
    await expect(
      asStranger(t).query(api.earnings.forOrg, { orgSlug: "publisher-co" }),
    ).rejects.toThrow(/Not a member/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedPublisherWorld(t);
    await expect(
      t.query(api.earnings.forOrg, { orgSlug: "publisher-co" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("aggregates by project with 95% publisher net", async () => {
    const t = convexTest(schema, modules);
    await seedPublisherWorld(t);
    const asPub = asPublisher(t);

    const earnings = await asPub.query(api.earnings.forOrg, {
      orgSlug: "publisher-co",
    });

    // All-time: 100+200+40 = 340 gross → net 323 (95%).
    expect(earnings.allTime).toEqual({
      calls: 3,
      grossCredits: 340,
      netCredits: Math.round(340 * 0.95),
    });
    // Month: 100+40 = 140 gross → net 133.
    expect(earnings.month).toEqual({
      calls: 2,
      grossCredits: 140,
      netCredits: Math.round(140 * 0.95),
    });

    const alpha = earnings.byProject.find((p) => p.slug === "alpha");
    const beta = earnings.byProject.find((p) => p.slug === "beta");
    expect(alpha).toMatchObject({
      name: "Alpha API",
      calls: 2,
      grossCredits: 300,
      netCredits: Math.round(300 * 0.95),
    });
    expect(beta).toMatchObject({
      name: "Beta API",
      calls: 1,
      grossCredits: 40,
      netCredits: Math.round(40 * 0.95),
    });
    // 95% invariant holds exactly on each bucket.
    expect(alpha!.netCredits).toBe(285);
    expect(beta!.netCredits).toBe(38);
    expect(earnings.month.netCredits).toBe(133);
    expect(earnings.allTime.netCredits).toBe(323);
  });
});

describe("specs.getVersion", () => {
  it("returns version for project member", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedPublisherWorld(t);
    const asPub = asPublisher(t);

    const version = await asPub.query(api.specs.getVersion, {
      versionId: seed.versionId,
    });
    expect(version.version).toBe("1.0.0");
    expect(version.publishedAt).toBeGreaterThan(0);
    expect(JSON.parse(version.spec).info.title).toBe("Alpha");
  });

  it("rejects non-member of owning org", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedPublisherWorld(t);
    await expect(
      asStranger(t).query(api.specs.getVersion, {
        versionId: seed.versionId,
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedPublisherWorld(t);
    await expect(
      t.query(api.specs.getVersion, { versionId: seed.versionId }),
    ).rejects.toThrow(/Not authenticated/);
  });
});
