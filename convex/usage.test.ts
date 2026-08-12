/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  consumerOrgId: Id<"organizations">;
  publisherOrgId: Id<"organizations">;
  projectAId: Id<"projects">;
  projectBId: Id<"projects">;
  monthStart: number;
  inMonth: number;
  prevMonth: number;
};

async function seedWorld(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  const now = Date.now();
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const inMonth = monthStart + 3 * 24 * 60 * 60 * 1000;
  const prevMonth = monthStart - 5 * 24 * 60 * 60 * 1000;

  return await t.run(async (ctx) => {
    const consumerOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_consumer",
      name: "Consumer Co",
      slug: "consumer-co",
    });
    const publisherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher Co",
      slug: "publisher-co",
    });

    const projectAId = await ctx.db.insert("projects", {
      organizationId: publisherOrgId,
      name: "Weather API",
      slug: "weather",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const projectBId = await ctx.db.insert("projects", {
      organizationId: publisherOrgId,
      name: "Maps API",
      slug: "maps",
      status: "published",
      visibility: "public",
      tags: [],
    });

    // In-month usage on two keys / two projects.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 10,
      status: 200,
      latencyMs: 40,
      keyId: "key_alpha",
      ownerUserId: "user_member",
      at: inMonth,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 20,
      status: 200,
      latencyMs: 55,
      keyId: "key_alpha",
      ownerUserId: "user_member",
      at: inMonth + 1,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectBId,
      endpoint: "/v1/geocode",
      method: "POST",
      credits: 50,
      status: 201,
      latencyMs: 90,
      keyId: "key_beta",
      ownerUserId: "user_sibling",
      at: inMonth + 2,
    });
    // Prior month — must not land in cycleBreakdown.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 999,
      status: 200,
      latencyMs: 10,
      keyId: "key_alpha",
      ownerUserId: "user_member",
      at: prevMonth,
    });
    // 5xx still recorded by gateway — counts for cycle totals.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 5,
      status: 502,
      latencyMs: 1200,
      keyId: "key_beta",
      ownerUserId: "user_sibling",
      at: inMonth + 3,
    });

    return {
      consumerOrgId,
      publisherOrgId,
      projectAId,
      projectBId,
      monthStart,
      inMonth,
      prevMonth,
    };
  });
}

function asMember(t: ReturnType<typeof convexTest>, clerkOrgId: string) {
  return t.withIdentity({
    subject: "user_member",
    // Clerk JWT template flattens org claims onto identity.
    org_id: clerkOrgId,
    org_slug: clerkOrgId === "org_consumer" ? "consumer-co" : "publisher-co",
    org_role: "org:admin",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asOrgMember(t: ReturnType<typeof convexTest>, userId: string) {
  return t.withIdentity({
    subject: userId,
    org_id: "org_consumer",
    org_slug: "consumer-co",
    org_role: "org:member",
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

describe("usage.listForOrg", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const outsider = t.withIdentity({
      subject: "user_outsider",
      org_id: "org_other",
      org_slug: "other",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });

    await expect(
      outsider.query(api.usage.listForOrg, {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not a member/);
  });

  it("rejects unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await expect(
      t.query(api.usage.listForOrg, {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("paginates newest first with project name+slug joined", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const asConsumer = asMember(t, "org_consumer");

    const page1 = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 2, cursor: null },
    });

    expect(page1.page).toHaveLength(2);
    expect(page1.isDone).toBe(false);
    // Newest first: inMonth+3 then inMonth+2.
    expect(page1.page[0]!.at).toBeGreaterThan(page1.page[1]!.at);
    expect(page1.page[0]!.projectName).toBe("Weather API");
    expect(page1.page[0]!.projectSlug).toBe("weather");

    const page2 = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 10, cursor: page1.continueCursor },
    });
    expect(page2.page.length).toBeGreaterThan(0);
    expect(page2.isDone).toBe(true);

    // keyId filter post-index.
    const onlyAlpha = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 50, cursor: null },
      keyId: "key_alpha",
    });
    expect(onlyAlpha.page.every((event) => event.keyLabel === "••••lpha")).toBe(
      true,
    );
    expect(onlyAlpha.page.every((event) => !Reflect.has(event, "keyId"))).toBe(
      true,
    );
    expect(onlyAlpha.page.length).toBe(3);

    // projectId filter.
    const onlyB = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 50, cursor: null },
      projectId: seed.projectBId,
    });
    expect(onlyB.page).toHaveLength(1);
    expect(onlyB.page[0]!.projectSlug).toBe("maps");

    // since/until window excludes prev month when set to current month.
    const monthOnly = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 50, cursor: null },
      since: seed.monthStart,
      until: seed.monthStart + 32 * 24 * 60 * 60 * 1000,
    });
    expect(monthOnly.page.every((e) => e.at >= seed.monthStart)).toBe(true);
    expect(monthOnly.page.some((e) => e.credits === 999)).toBe(false);
  });

  it("shows members only own usage while admin retains opaque org attribution", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const memberRows = await asOrgMember(t, "user_member").query(
      api.usage.listForOrg,
      {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 50, cursor: null },
      },
    );
    expect(memberRows.page).toHaveLength(3);
    expect(memberRows.page.every((event) => event.keyLabel === "••••lpha")).toBe(
      true,
    );
    expect(memberRows.page.every((event) => event.ownerRef === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(memberRows.page)).not.toContain("key_alpha");
    expect(JSON.stringify(memberRows.page)).not.toContain("user_member");

    const adminRows = await asMember(t, "org_consumer").query(
      api.usage.listForOrg,
      {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 50, cursor: null },
      },
    );
    expect(adminRows.page).toHaveLength(5);
    expect(adminRows.page.every((event) => event.ownerRef !== undefined)).toBe(
      true,
    );
    expect(adminRows.page.every((event) => !Reflect.has(event, "projectId"))).toBe(
      true,
    );
  });
});

describe("billing.cycleBreakdown", () => {
  it("rejects non-member", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const outsider = t.withIdentity({
      subject: "user_outsider",
      org_id: "org_other",
      org_slug: "other",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    await expect(
      outsider.query(api.billing.cycleBreakdown, { orgSlug: "consumer-co" }),
    ).rejects.toThrow(/Not a member/);
  });

  it("aggregates current UTC month byKey and byProject", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const asConsumer = asMember(t, "org_consumer");

    const breakdown = await asConsumer.query(api.billing.cycleBreakdown, {
      orgSlug: "consumer-co",
    });

    // In-month: 10+20+50+5 = 85 credits, 4 calls. Prev-month 999 excluded.
    expect(breakdown.totalCalls).toBe(4);
    expect(breakdown.totalCredits).toBe(85);
    expect(breakdown.cycleStart).toBeLessThanOrEqual(Date.now());
    expect(breakdown.cycleEnd).toBeGreaterThan(breakdown.cycleStart);

    const alpha = breakdown.byKey.find((key) => key.keyLabel === "••••lpha");
    const beta = breakdown.byKey.find((key) => key.keyLabel === "••••beta");
    expect(alpha).toMatchObject({ calls: 2, credits: 30 });
    expect(beta).toMatchObject({ calls: 2, credits: 55 });
    expect(breakdown.byKey.every((key) => !Reflect.has(key, "keyId"))).toBe(
      true,
    );

    const weather = breakdown.byProject.find((p) => p.slug === "weather");
    const maps = breakdown.byProject.find((p) => p.slug === "maps");
    expect(weather).toMatchObject({
      name: "Weather API",
      calls: 3,
      credits: 35,
    });
    expect(maps).toMatchObject({ name: "Maps API", calls: 1, credits: 50 });
  });

  it("filters member billing totals to server-derived ownership", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const breakdown = await asOrgMember(t, "user_member").query(
      api.billing.cycleBreakdown,
      { orgSlug: "consumer-co" },
    );
    expect(breakdown).toMatchObject({ totalCalls: 2, totalCredits: 30 });
    expect(breakdown.byKey).toEqual([
      expect.objectContaining({ keyLabel: "••••lpha", calls: 2, credits: 30 }),
    ]);
    expect(breakdown.byKey[0]).not.toHaveProperty("ownerRef");
  });
});
