/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { projectedCycleCredits } from "./billing";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  consumerOrgId: Id<"organizations">;
  publisherOrgId: Id<"organizations">;
  projectAId: Id<"projects">;
  projectBId: Id<"projects">;
  eventAId: Id<"usageEvents">;
  eventMemberId: Id<"usageEvents">;
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
      publicHandle: "publisher-co",
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

    await ctx.db.insert("users", {
      clerkUserId: "user_alice",
      name: "Alice Admin",
      email: "alice@example.com",
    });
    await ctx.db.insert("users", {
      clerkUserId: "user_member",
      name: "Morgan Member",
      email: "morgan@example.com",
    });
    await ctx.db.insert("keySettings", {
      clerkOrgId: "org_consumer",
      keyId: "key_alpha",
      ownerUserId: "user_alice",
      keyName: "CI",
      disabled: false,
      updatedAt: 1,
    });
    await ctx.db.insert("keySettings", {
      clerkOrgId: "org_consumer",
      keyId: "key_beta",
      keyName: "Production agent",
      ownerUserId: "user_member",
      disabled: false,
      updatedAt: 1,
    });

    // In-month usage on two keys / two projects.
    const eventAId = await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      projectName: "Weather API",
      projectSlug: "weather",
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 10,
      status: 200,
      latencyMs: 40,
      keyId: "key_alpha",
      ownerUserId: "user_alice",
      at: inMonth,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      projectName: "Weather API",
      projectSlug: "weather",
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 20,
      status: 200,
      latencyMs: 55,
      keyId: "key_alpha",
      at: inMonth + 1,
    });
    const eventMemberId = await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectBId,
      projectName: "Maps API",
      projectSlug: "maps",
      endpoint: "/v1/geocode",
      method: "POST",
      credits: 50,
      status: 201,
      latencyMs: 90,
      keyId: "key_beta",
      ownerUserId: "user_member",
      at: inMonth + 2,
    });
    // Prior month — must not land in cycleBreakdown.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      projectName: "Weather API",
      projectSlug: "weather",
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 999,
      status: 200,
      latencyMs: 10,
      keyId: "key_alpha",
      ownerUserId: "user_alice",
      at: prevMonth,
    });
    // 5xx still recorded by gateway — counts for cycle totals.
    await ctx.db.insert("usageEvents", {
      organizationId: consumerOrgId,
      projectId: projectAId,
      projectName: "Weather API",
      projectSlug: "weather",
      endpoint: "/v1/forecast",
      method: "GET",
      credits: 5,
      status: 502,
      latencyMs: 1200,
      keyId: "key_beta",
      ownerUserId: "user_member",
      at: inMonth + 3,
    });

    return {
      consumerOrgId,
      publisherOrgId,
      projectAId,
      projectBId,
      eventAId,
      eventMemberId,
      monthStart,
      inMonth,
      prevMonth,
    };
  });
}

function withRole(
  t: ReturnType<typeof convexTest>,
  clerkOrgId: string,
  role: "org:admin" | "org:owner" | "org:member",
  subject = role === "org:member" ? "user_member" : "user_alice",
) {
  return t.withIdentity({
    subject,
    // Clerk JWT template flattens org claims onto identity.
    org_id: clerkOrgId,
    org_slug: clerkOrgId === "org_consumer" ? "consumer-co" : "publisher-co",
    org_role: role,
  } as {
    subject: string;
    org_id: string;
    org_slug: string;
    org_role: string;
  });
}

function asAdmin(t: ReturnType<typeof convexTest>, clerkOrgId: string) {
  return withRole(t, clerkOrgId, "org:admin");
}

function asMember(t: ReturnType<typeof convexTest>, clerkOrgId: string) {
  return withRole(t, clerkOrgId, "org:member");
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
    ).rejects.toThrow(/Organization not found/);
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
    const asConsumer = asAdmin(t, "org_consumer");

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
    expect(onlyAlpha.page.every((e) => e.keyId === "key_alpha")).toBe(true);
    expect(onlyAlpha.page.length).toBe(3);

    // Public project reference filter. Internal Convex IDs never cross this API.
    const onlyB = await asConsumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 50, cursor: null },
      projectRef: "publisher-co/maps",
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

  it("resolves an authorized deep link by ID and hides cross-org events", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const event = await asAdmin(t, "org_consumer").query(
      api.usage.getForOrgById,
      { orgSlug: "consumer-co", eventId: seed.eventAId },
    );
    expect(event).toMatchObject({
      eventId: String(seed.eventAId),
      projectName: "Weather API",
      endpoint: "/v1/forecast",
      credits: 10,
    });

    expect(
      await asAdmin(t, "org_publisher").query(api.usage.getForOrgById, {
        orgSlug: "consumer-co",
        eventId: seed.eventAId,
      }),
    ).toBeNull();
    expect(
      await asAdmin(t, "org_publisher").query(api.usage.getForOrgById, {
        orgSlug: "publisher-co",
        eventId: seed.eventAId,
      }),
    ).toBeNull();
  });

  it("scopes ordinary members to their own masked usage and blocks colleague deep links", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const member = asMember(t, "org_consumer");

    const result = await member.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(result.access.role).toBe("org:member");
    expect(result.access.capabilities.viewOrgUsage).toBe(false);
    expect(result.page).toHaveLength(2);
    expect(result.page.every((event) => event.keyId === "••••beta")).toBe(true);
    expect(result.page.every((event) => !("memberId" in event))).toBe(true);
    expect(result.page.every((event) => !("memberName" in event))).toBe(true);

    expect(
      await member.query(api.usage.getForOrgById, {
        orgSlug: "consumer-co",
        eventId: seed.eventAId,
      }),
    ).toBeNull();
    expect(
      await member.query(api.usage.getForOrgById, {
        orgSlug: "consumer-co",
        eventId: seed.eventMemberId,
      }),
    ).toMatchObject({ eventId: String(seed.eventMemberId), keyId: "••••beta" });

    const forcedColleague = await member.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      memberId: "user_alice",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(forcedColleague.page).toEqual([]);
  });
});

describe("billing.cycleBreakdown", () => {
  it("projects linearly without dropping below spend already incurred", () => {
    expect(projectedCycleCredits(100, 0, 1_000, 250)).toBe(400);
    expect(projectedCycleCredits(100, 0, 1_000, 2_000)).toBe(100);
    expect(projectedCycleCredits(0, 0, 1_000, 250)).toBe(0);
  });

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
    ).rejects.toThrow(/Organization not found/);
  });

  it("attributes current-cycle spend by named key, member, API, and endpoint", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const asConsumer = asAdmin(t, "org_consumer");

    const breakdown = await asConsumer.query(api.billing.cycleBreakdown, {
      orgSlug: "consumer-co",
    });

    // In-month: 10+20+50+5 = 85 credits, 4 calls. Prev-month 999 excluded.
    expect(breakdown.totalCalls).toBe(4);
    expect(breakdown.totalCredits).toBe(85);
    expect(breakdown.cycleStart).toBeLessThanOrEqual(Date.now());
    expect(breakdown.cycleEnd).toBeGreaterThan(breakdown.cycleStart);
    expect(breakdown.projectedCredits).toBeGreaterThanOrEqual(85);

    const alpha = breakdown.byKey.find((k) => k.keyId === "key_alpha");
    const beta = breakdown.byKey.find((k) => k.keyId === "key_beta");
    expect(alpha).toMatchObject({
      keyName: "CI",
      memberId: "user_alice",
      calls: 2,
      credits: 30,
    });
    expect(beta).toMatchObject({
      keyName: "Production agent",
      memberId: "user_member",
      calls: 2,
      credits: 55,
    });

    const weather = breakdown.byProject.find((p) => p.slug === "weather");
    const maps = breakdown.byProject.find((p) => p.slug === "maps");
    expect(weather).toMatchObject({
      name: "Weather API",
      calls: 3,
      credits: 35,
    });
    expect(maps).toMatchObject({ name: "Maps API", calls: 1, credits: 50 });

    expect(breakdown.byMember).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: "user_alice",
          name: "Alice Admin",
          calls: 2,
          credits: 30,
        }),
        expect.objectContaining({
          memberId: "user_member",
          name: "Morgan Member",
          calls: 2,
          credits: 55,
        }),
      ]),
    );
    expect(breakdown.byEndpoint).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectName: "Weather API",
          method: "GET",
          endpoint: "/v1/forecast",
          calls: 3,
          credits: 35,
        }),
        expect.objectContaining({
          projectName: "Maps API",
          method: "POST",
          endpoint: "/v1/geocode",
          calls: 1,
          credits: 50,
        }),
      ]),
    );
  });

  it("returns only self spend without member attribution to ordinary members", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);

    const breakdown = await asMember(t, "org_consumer").query(
      api.billing.cycleBreakdown,
      { orgSlug: "consumer-co" },
    );

    expect(breakdown.scope).toBe("member");
    expect(breakdown.totalCalls).toBe(2);
    expect(breakdown.totalCredits).toBe(55);
    expect(breakdown.ownCalls).toBe(2);
    expect(breakdown.ownCredits).toBe(55);
    expect(breakdown.byMember).toEqual([]);
    expect(breakdown.byKey).toEqual([
      expect.objectContaining({
        keyId: "••••beta",
        memberId: null,
        calls: 2,
        credits: 55,
      }),
    ]);
  });
});

describe("usage.listForOrg — scope and pagination hardening", () => {
  it("scopes by signed org id even when another org slug is supplied", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other",
        slug: "other",
      });
    });
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

    const result = await outsider.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toEqual([]);
  });

  it("applies combined filters with gap-free result sets across pages", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 8; index += 1) {
        await ctx.db.insert("usageEvents", {
          organizationId: seed.consumerOrgId,
          projectId: index % 2 === 0 ? seed.projectAId : seed.projectBId,
          endpoint: `/interleaved/${index}`,
          method: "GET",
          credits: index,
          status: 200,
          latencyMs: index,
          keyId: index % 3 === 0 ? "key_target" : "key_noise",
          at: seed.inMonth + 100 + index,
        });
      }
    });
    const consumer = asAdmin(t, "org_consumer");
    const seen: string[] = [];
    let cursor: string | null = null;
    let done = false;
    while (!done) {
      const result = await consumer.query(api.usage.listForOrg, {
        orgSlug: "consumer-co",
        projectRef: "publisher-co/weather",
        keyId: "key_target",
        paginationOpts: { numItems: 3, cursor },
      });
      for (const event of result.page) {
        expect(event.projectRef).toBe("publisher-co/weather");
        expect(event.keyId).toBe("key_target");
        seen.push(event.endpoint);
      }
      cursor = result.continueCursor;
      done = result.isDone;
    }
    expect(seen).toEqual(["/interleaved/6", "/interleaved/0"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("caps attacker-controlled page sizes and rejects invalid time windows", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 80; index += 1) {
        await ctx.db.insert("usageEvents", {
          organizationId: seed.consumerOrgId,
          projectId: seed.projectAId,
          endpoint: `/bulk/${index}`,
          method: "GET",
          credits: 1,
          status: 200,
          latencyMs: 1,
          keyId: "bulk-key",
          at: seed.inMonth + 1_000 + index,
        });
      }
    });
    const consumer = asAdmin(t, "org_consumer");
    const capped = await consumer.query(api.usage.listForOrg, {
      orgSlug: "consumer-co",
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(capped.page).toHaveLength(50);
    expect(capped.isDone).toBe(false);
    await expect(
      consumer.query(api.usage.listForOrg, {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 1, cursor: null },
        since: 10,
        until: 10,
      }),
    ).rejects.toThrow(/before end time/);
    await expect(
      consumer.query(api.usage.listForOrg, {
        orgSlug: "consumer-co",
        paginationOpts: { numItems: 1, cursor: null },
        since: -5,
      }),
    ).rejects.toThrow(/Invalid start time/);
  });
});

describe("analytics.orgOverview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps recent calls across month boundaries and survives Clerk slug drift", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const renamedInClerk = t.withIdentity({
      subject: "user_consumer",
      org_id: "org_consumer",
      org_slug: "brand-new-slug",
      org_role: "org:admin",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });

    const overview = await renamedInClerk.query(api.analytics.orgOverview, {
      orgSlug: "brand-new-slug",
    });
    expect(overview.recent.some((event) => event.credits === 999)).toBe(true);
    expect(overview.callsCycle).toBe(4);
    expect(overview.creditsCycle).toBe(85);
  });

  it("reports publisher net earnings separately from gross usage credits", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: seed.publisherOrgId,
        consumerOrganizationId: seed.consumerOrgId,
        projectId: seed.projectAId,
        usageSettlementRefId: "settle:net-analytics",
        grossCredits: 100,
        platformFeeAtoms: 50_000,
        publisherNetAtoms: 950_000,
        platformFeeCredits: 5,
        netCredits: 95,
        clawedBackGrossCredits: 0,
        clawedBackAtoms: 0,
        releasedAtoms: 0,
        availableAt: now,
        status: "available",
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await asAdmin(t, "org_publisher").query(
      api.analytics.projectAnalytics,
      { orgSlug: "publisher-co", projectSlug: "weather", rangeDays: 7 },
    );
    expect(result?.netCredits).toBe(95);
    expect(result?.netCredits).not.toBe(100);
  });

  it("does not expose sibling or unattributed usage in member rollups", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedWorld(t);
    await t.run(async (ctx) => {
      for (const [ownerUserId, endpoint, credits] of [
        ["user_alice", "/owned/alice", 7],
        ["user_bob", "/owned/bob", 11],
      ] as const) {
        await ctx.db.insert("usageEvents", {
          organizationId: seed.consumerOrgId,
          ownerUserId,
          projectId: seed.projectAId,
          endpoint,
          method: "GET",
          credits,
          status: 200,
          latencyMs: credits,
          keyId: `key_${ownerUserId}`,
          at: Date.now(),
        });
      }
    });
    const alice = t.withIdentity({
      subject: "user_alice",
      org_id: "org_consumer",
      org_slug: "consumer-co",
      org_role: "org:member",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
    });
    const overview = await alice.query(api.analytics.orgOverview, {
      orgSlug: "consumer-co",
    });
    // One in-month forecast call carries ownerUserId user_alice; the other
    // forecast row is unattributed, and sibling/unattributed rows stay hidden.
    expect(overview.callsCycle).toBe(2);
    expect(overview.creditsCycle).toBe(17);
    expect(
      overview.recent
        .map((event) => event.endpoint)
        .filter((endpoint) => endpoint === "/owned/bob"),
    ).toEqual([]);
  });
});

describe("billing.cycleBreakdown — scope hardening", () => {
  it("never uses a supplied slug to escape the signed org scope", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other",
        slug: "other",
      });
    });
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
    const result = await outsider.query(api.billing.cycleBreakdown, {
      orgSlug: "consumer-co",
    });
    expect(result.totalCalls).toBe(0);
    expect(result.totalCredits).toBe(0);
  });

  it("aggregates current UTC month and reports scan bounds", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    const asConsumer = asAdmin(t, "org_consumer");

    const breakdown = await asConsumer.query(api.billing.cycleBreakdown, {
      orgSlug: "consumer-co",
    });

    expect(breakdown.totalCalls).toBe(4);
    expect(breakdown.totalCredits).toBe(85);
    expect(breakdown.cycleStart).toBeLessThanOrEqual(Date.now());
    expect(breakdown.cycleEnd).toBeGreaterThan(breakdown.cycleStart);

    const alpha = breakdown.byKey.find((k) => k.keyId === "key_alpha");
    const beta = breakdown.byKey.find((k) => k.keyId === "key_beta");
    expect(alpha).toMatchObject({ calls: 2, credits: 30, keyName: "CI" });
    expect(beta).toMatchObject({
      calls: 2,
      credits: 55,
      keyName: "Production agent",
    });

    const weather = breakdown.byProject.find((p) => p.slug === "weather");
    const maps = breakdown.byProject.find((p) => p.slug === "maps");
    expect(weather).toMatchObject({
      name: "Weather API",
      calls: 3,
      credits: 35,
    });
    expect(maps).toMatchObject({ name: "Maps API", calls: 1, credits: 50 });
    expect(breakdown.scanTruncated).toBe(false);
    expect(breakdown.scanCap).toBe(10_000);
  });
});
