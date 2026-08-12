/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MIN_DEPRECATION_NOTICE_MS } from "./projects";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function asPublisher(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    subject: "publisher_admin",
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

afterEach(() => vi.useRealTimers());

describe("retirement consumer fanout", () => {
  it("paginates, deduplicates, and invalidates stale reschedule jobs", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_publisher",
        name: "Publisher",
        slug: "publisher",
        publicHandle: "publisher",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: publisherId,
        name: "Payments API",
        slug: "payments",
        status: "published",
        visibility: "public",
        tags: [],
      });
      for (let index = 0; index < 130; index += 1) {
        const consumerId = await ctx.db.insert("organizations", {
          clerkOrgId: `org_consumer_${index}`,
          name: `Consumer ${index}`,
          slug: `consumer-${index}`,
          publicHandle: `consumer-${index}`,
        });
        // Duplicate usage can cross pagination boundaries; notification refIds
        // still guarantee one notice per consumer and schedule revision.
        for (let call = 0; call < 2; call += 1) {
          await ctx.db.insert("usageEvents", {
            organizationId: consumerId,
            projectId,
            endpoint: "/charge",
            method: "POST",
            credits: 100,
            status: 200,
            latencyMs: 10,
            keyId: `key_${index}`,
            at: now + index * 2 + call,
          });
        }
      }
      return projectId;
    });

    const firstSunset = now + MIN_DEPRECATION_NOTICE_MS + 60_000;
    const finalSunset = firstSunset + 86_400_000;
    await asPublisher(t).mutation(api.projects.scheduleRetirement, {
      projectId,
      sunsetAt: firstSunset,
      message: "Old guidance",
    });
    // Commit a real first-schedule page before rescheduling. Later fanout must
    // replace those rows, not leave stale notices behind.
    await t.mutation(internal.projects.notifyRetirementConsumersPage, {
      projectId,
      retirementRevision: 1,
      sunsetAt: firstSunset,
      event: "scheduled",
      cursor: null,
    });
    const rescheduled = await asPublisher(t).mutation(
      api.projects.scheduleRetirement,
      {
        projectId,
        sunsetAt: finalSunset,
        message: "Move to Payments v2",
      },
    );
    expect(rescheduled.retirementRevision).toBe(2);
    expect(
      await asPublisher(t).mutation(api.projects.scheduleRetirement, {
        projectId,
        sunsetAt: finalSunset,
        message: "Move to Payments v2",
      }),
    ).toMatchObject({ retirementRevision: 2 });

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    let notifications = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    const consumerNotifications = notifications.filter(
      (notification) => notification.clerkOrgId !== "org_publisher",
    );
    expect(consumerNotifications).toHaveLength(130);
    expect(
      new Set(
        consumerNotifications.map((notification) => notification.clerkOrgId),
      ).size,
    ).toBe(130);
    expect(
      consumerNotifications.every(
        (notification) =>
          notification.body.includes("Move to Payments v2") &&
          notification.body.includes(new Date(finalSunset).toISOString()) &&
          notification.publisherHandle === "publisher" &&
          notification.projectSlug === "payments",
      ),
    ).toBe(true);
    expect(
      consumerNotifications.some((notification) =>
        notification.body.includes("Old guidance"),
      ),
    ).toBe(false);

    await t.mutation(internal.projects.notifyRetirementConsumersPage, {
      projectId,
      retirementRevision: 2,
      sunsetAt: finalSunset,
      event: "scheduled",
      cursor: null,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    notifications = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    expect(
      notifications.filter(
        (notification) => notification.clerkOrgId !== "org_publisher",
      ),
    ).toHaveLength(130);

    const canceled = await asPublisher(t).mutation(
      api.projects.cancelRetirement,
      { projectId },
    );
    expect(canceled.retirementRevision).toBe(3);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    notifications = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    const canceledConsumerNotices = notifications.filter(
      (notification) => notification.clerkOrgId !== "org_publisher",
    );
    expect(canceledConsumerNotices).toHaveLength(130);
    expect(
      canceledConsumerNotices.every(
        (notification) =>
          notification.title.endsWith("retirement canceled") &&
          notification.body.includes("was canceled"),
      ),
    ).toBe(true);
    expect(notifications).toHaveLength(131);
  });

  it("reconciles a late settlement inserted behind the fanout cursor", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sunsetAt = now + MIN_DEPRECATION_NOTICE_MS + 60_000;
    const t = convexTest(schema, modules);
    const seed = await t.run(async (ctx) => {
      const publisherId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_publisher",
        name: "Publisher",
        slug: "publisher",
        publicHandle: "publisher",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: publisherId,
        name: "Payments API",
        slug: "payments",
        status: "published",
        visibility: "public",
        tags: [],
        deprecationStartedAt: now,
        sunsetAt,
        deprecationMessage: "Move to Payments v2",
        retirementState: "scheduled",
        retirementRevision: 1,
      });
      const historicalConsumerId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_historical_consumer",
        name: "Historical consumer",
        slug: "historical-consumer",
      });
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("usageEvents", {
          organizationId: historicalConsumerId,
          projectId,
          endpoint: "/charge",
          method: "POST",
          credits: 1,
          status: 200,
          latencyMs: 10,
          keyId: "key_historical",
          at: now + index,
        });
      }
      const lateConsumerId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_late_consumer",
        name: "Late consumer",
        slug: "late-consumer",
      });
      await ctx.db.insert("wallets", {
        organizationId: lateConsumerId,
        balance: 10,
        sequence: 0,
      });
      return { projectId, publisherId, lateConsumerId };
    });

    expect(
      await t.mutation(internal.projects.notifyRetirementConsumersPage, {
        projectId: seed.projectId,
        retirementRevision: 1,
        sunsetAt,
        event: "scheduled",
        cursor: null,
      }),
    ).toMatchObject({ scanned: 100, done: false });

    await t.mutation(internal.wallets.recordUsage, {
      events: [
        {
          organizationId: seed.publisherId,
          projectId: seed.projectId,
          endpoint: "/charge",
          method: "POST",
          credits: 1,
          status: 200,
          latencyMs: 10,
          keyId: "key_late",
          // Older event time puts this row behind the already-committed cursor.
          at: now - 1,
          settleRefId: "settle:late-retirement-consumer",
          consumerClerkOrgId: "org_late_consumer",
        },
      ],
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const lateNotice = await t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_ref", (q) =>
          q.eq(
            "refId",
            `project_retirement:${seed.projectId}:consumer:org_late_consumer`,
          ),
        )
        .unique(),
    );
    expect(lateNotice).toMatchObject({
      clerkOrgId: "org_late_consumer",
      publisherHandle: "publisher",
      projectSlug: "payments",
    });
    expect(lateNotice?.body).toContain("Move to Payments v2");
  });
});

describe("retirement queue draining", () => {
  it("drains more than 100 scheduled rows and preserves immutable cutoffs", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const cutoff = Date.now() - 1;
    const projectIds = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_publisher",
        name: "Publisher",
        slug: "publisher",
        publicHandle: "publisher",
      });
      const ids: Id<"projects">[] = [];
      for (let index = 0; index < 205; index += 1) {
        ids.push(
          await ctx.db.insert("projects", {
            organizationId: orgId,
            name: `API ${index}`,
            slug: `api-${index}`,
            status: "published",
            visibility: "public",
            tags: [],
            deprecationStartedAt: cutoff - MIN_DEPRECATION_NOTICE_MS,
            sunsetAt: cutoff,
            deprecationMessage: "Retire",
            retirementState: "scheduled",
            retirementRevision: 1,
          }),
        );
      }
      for (let index = 0; index < 215; index += 1) {
        await ctx.db.insert("upstreamCredentials", {
          projectId: ids[204]!,
          name: `x-secret-${index}`,
          secret: `legacy-${index}`,
          updatedAt: index,
        });
      }
      await ctx.db.insert("specVersions", {
        projectId: ids[0]!,
        version: "1.0.0",
        spec: JSON.stringify({
          openapi: "3.1.0",
          servers: [{ url: "https://api.example.test" }],
          paths: {},
        }),
        publishedAt: cutoff - 1,
      });
      return ids;
    });

    expect(
      await t.mutation(internal.projects.retireSunsetProjects, {}),
    ).toEqual({ retired: 100, hasMore: true });
    expect(
      await t.mutation(internal.projects.retireSunsetProjects, {}),
    ).toEqual({ retired: 100, hasMore: true });
    expect(
      await t.mutation(internal.projects.retireSunsetProjects, {}),
    ).toEqual({ retired: 5, hasMore: false });

    const projects = await t.run(async (ctx) =>
      Promise.all(projectIds.map((projectId) => ctx.db.get(projectId))),
    );
    expect(
      projects.every(
        (project) =>
          project?.retirementState === "retired" &&
          project.retirementCutoffAt === cutoff &&
          project.sunsetAt === undefined &&
          project.visibility === "private" &&
          project.retiredAt !== undefined,
      ),
    ).toBe(true);
    const gateway = await t.query(
      internal.specs.getPublishedForGatewayInternal,
      { publisherHandle: "publisher", projectSlug: "api-0" },
    );
    expect(gateway).toMatchObject({
      sunsetAt: cutoff,
      visibility: "private",
      retiredAt: expect.any(Number),
    });

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("upstreamCredentials")
          .withIndex("by_project", (q) => q.eq("projectId", projectIds[204]!))
          .collect(),
      ),
    ).toHaveLength(0);
  });
});
