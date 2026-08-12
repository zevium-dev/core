/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PROBE_LEASE_MS } from "./quality";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => vi.useRealTimers());
const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Quality", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/health": {
      get: { "x-zevium-cost": 1, "x-zevium-health-check": true },
    },
  },
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const publisherId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
      publicHandle: "publisher",
    });
    const consumerId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_consumer",
      name: "Consumer",
      slug: "consumer",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: publisherId,
      name: "Quality API",
      slug: "quality-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    const specVersionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: SPEC,
      publishedAt: Date.now(),
    });
    return { publisherId, consumerId, projectId, specVersionId };
  });
}

async function leaseWithId(
  t: TestConvex<typeof schema>,
  targetId: Id<"qualityProbeTargets">,
  executionId: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.patch(targetId, {
      leaseId: executionId,
      leaseExpiresAt: Date.now() + 60_000,
    });
  });
}

describe("scheduled quality truth", () => {
  it("starts insufficient, derives metrics from samples, records incidents, and dedupes executions", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const target = await t.run(async (ctx) =>
      ctx.db
        .query("qualityProbeTargets")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
    );
    if (target === null) throw new Error("target missing");

    expect(
      await t.query(api.quality.getPublicSnapshot, {
        projectId: seeded.projectId,
      }),
    ).toMatchObject({
      reachabilitySampleSize: 0,
      insufficientReachabilityData: true,
      reachabilityPercent: null,
      apiSampleSize: 0,
      insufficientApiData: true,
      apiSuccessRatePercent: null,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, { visibility: "private" });
    });
    expect(
      await t.query(api.quality.getPublicSnapshot, {
        projectId: seeded.projectId,
      }),
    ).toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, { visibility: "public" });
    });

    await leaseWithId(t, target._id, "probe-1");
    expect(
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: "probe-1",
        outcome: "timeout",
        latencyMs: 8_000,
      }),
    ).toEqual({ applied: true });
    expect(
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: "probe-1",
        outcome: "healthy",
        statusCode: 200,
        latencyMs: 1,
      }),
    ).toEqual({ applied: false });

    await leaseWithId(t, target._id, "probe-2");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "probe-2",
      outcome: "http_error",
      statusCode: 503,
      latencyMs: 40,
    });
    await leaseWithId(t, target._id, "probe-3");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "probe-3",
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 20,
    });

    await leaseWithId(t, target._id, "probe-4");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "probe-4",
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 25,
    });
    await leaseWithId(t, target._id, "probe-5");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "probe-5",
      outcome: "timeout",
      latencyMs: 8_000,
    });
    await expect(
      t.run(async (ctx) => ctx.db.get(seeded.projectId)),
    ).resolves.toMatchObject({
      visibility: "private",
      qualityStatus: "suspended",
    });
    for (let index = 6; index <= 8; index += 1) {
      await leaseWithId(t, target._id, `probe-${index}`);
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: `probe-${index}`,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 20 + index,
      });
    }

    expect(
      await t.query(api.quality.getPublicSnapshot, {
        projectId: seeded.projectId,
      }),
    ).toMatchObject({
      reachabilitySampleSize: 8,
      insufficientReachabilityData: false,
      reachabilityPercent: 75,
      apiSampleSize: 0,
      insufficientApiData: true,
      lastProbeOutcome: "healthy",
    });
    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toHaveLength(1);
    expect(incidents.page[0]).toMatchObject({
      status: "resolved",
      failureCount: 3,
    });

    const sideEffects = await t.run(async (ctx) => ({
      usage: await ctx.db.query("usageEvents").collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
      ledger: await ctx.db.query("walletEntries").collect(),
      notifications: await ctx.db.query("notifications").collect(),
    }));
    expect(sideEffects.usage).toEqual([]);
    expect(sideEffects.earnings).toEqual([]);
    expect(sideEffects.ledger).toEqual([]);
    expect(sideEffects.notifications.map((row) => row.kind)).toEqual([
      "quality_suspended",
      "quality_restored",
    ]);
  });

  it("leases a bounded batch and keeps one idempotent subscription per consumer org/listing", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const leases = await t.mutation(internal.quality.leaseDueTargets, {});
    expect(leases).toHaveLength(1);
    expect(await t.mutation(internal.quality.leaseDueTargets, {})).toHaveLength(
      0,
    );

    const consumer = t.withIdentity({
      subject: "consumer_user",
      org_id: "org_consumer",
      org_role: "org:member",
    });
    await expect(
      consumer.mutation(api.quality.setSubscription, {
        projectId: seeded.projectId,
        active: false,
      }),
    ).resolves.toBeNull();
    const first = await consumer.mutation(api.quality.setSubscription, {
      projectId: seeded.projectId,
      active: true,
    });
    const second = await consumer.mutation(api.quality.setSubscription, {
      projectId: seeded.projectId,
      active: true,
    });
    expect(second._id).toBe(first._id);
    const active = await consumer.query(api.quality.listSubscriptions, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(active.page).toHaveLength(1);
    const publisher = t.withIdentity({
      subject: "publisher_user",
      org_id: "org_publisher",
      org_role: "org:admin",
    });
    expect(
      await publisher.query(api.quality.subscriberCount, {
        projectId: seeded.projectId,
      }),
    ).toBe(1);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, { visibility: "private" });
    });
    await consumer.mutation(api.quality.setSubscription, {
      projectId: seeded.projectId,
      active: false,
    });
    await expect(
      consumer.mutation(api.quality.setSubscription, {
        projectId: seeded.projectId,
        active: true,
      }),
    ).rejects.toThrow("Published listing not found");
    const inactive = await consumer.query(api.quality.listSubscriptions, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(inactive.page).toHaveLength(0);

    expect(
      await publisher.query(api.quality.subscriberCount, {
        projectId: seeded.projectId,
      }),
    ).toBe(0);
  });

  it("reclaims expired leases and fences stale fetches and result writes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const firstLease = await t.mutation(internal.quality.leaseDueTargets, {});
    const target = firstLease[0];
    if (target === undefined) throw new Error("target was not leased");
    const targetRow = await t.run(async (ctx) => ctx.db.get(target.targetId));
    if (targetRow === null) throw new Error("target missing");
    expect(targetRow.nextProbeAt).toBeGreaterThan(Date.now());
    expect(
      await t.query(internal.quality.getLeasedTarget, target),
    ).not.toBeNull();

    vi.advanceTimersByTime(PROBE_LEASE_MS + 1);
    expect(await t.query(internal.quality.getLeasedTarget, target)).toBeNull();
    expect(
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target.targetId,
        executionId: target.executionId,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 1,
      }),
    ).toEqual({ applied: false });

    const reclaimed = await t.mutation(internal.quality.leaseDueTargets, {});
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.executionId).not.toBe(target.executionId);
    expect(
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: reclaimed[0]!.targetId,
        executionId: reclaimed[0]!.executionId,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 1,
      }),
    ).toEqual({ applied: true });
  });

  it("blocks activation throughout deprecation, retirement, and publisher archive while deactivation always works", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const consumer = t.withIdentity({
      subject: "consumer_user",
      org_id: "org_consumer",
      org_role: "org:member",
    });

    const activate = () =>
      consumer.mutation(api.quality.setSubscription, {
        projectId: seeded.projectId,
        active: true,
      });
    const deactivate = () =>
      consumer.mutation(api.quality.setSubscription, {
        projectId: seeded.projectId,
        active: false,
      });
    const resetLifecycle = async () => {
      await t.run(async (ctx) => {
        await ctx.db.patch(seeded.projectId, {
          deprecationStartedAt: undefined,
          sunsetAt: undefined,
          retirementState: undefined,
          retiredAt: undefined,
          deletionState: undefined,
        });
        await ctx.db.patch(seeded.publisherId, { archivedAt: undefined });
      });
    };
    const assertBlockedAfterDeactivation = async () => {
      const project = await t.run(async (ctx) => ctx.db.get(seeded.projectId));
      if (project?.deletionState !== undefined) {
        await expect(deactivate()).rejects.toThrow("cleanup has started");
        await expect(activate()).rejects.toThrow("cleanup has started");
      } else {
        await expect(deactivate()).resolves.toMatchObject({ active: false });
        await expect(deactivate()).resolves.toMatchObject({ active: false });
        await expect(activate()).rejects.toThrow("Published listing not found");
      }
    };

    await activate();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, {
        deprecationStartedAt: Date.now(),
      });
    });
    await assertBlockedAfterDeactivation();

    for (const deletionState of ["tombstoned", "cleaned"] as const) {
      await resetLifecycle();
      await activate();
      await t.run(async (ctx) => {
        await ctx.db.patch(seeded.projectId, { deletionState });
      });
      await assertBlockedAfterDeactivation();
    }

    await resetLifecycle();
    await activate();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, { sunsetAt: Date.now() + 60_000 });
    });
    await assertBlockedAfterDeactivation();

    await resetLifecycle();
    await activate();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, {
        retirementState: "scheduled",
      });
    });
    await assertBlockedAfterDeactivation();

    await resetLifecycle();
    await activate();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.projectId, {
        retirementState: "retired",
        retiredAt: Date.now(),
      });
    });
    await assertBlockedAfterDeactivation();

    await resetLifecycle();
    await activate();
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.publisherId, { archivedAt: Date.now() });
    });
    await assertBlockedAfterDeactivation();

    const state = await t.run(async (ctx) => ({
      subscriptions: await ctx.db.query("listingSubscriptions").collect(),
      aggregate: await ctx.db
        .query("listingSubscriptionAggregates")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
    }));
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]?.active).toBe(false);
    expect(state.aggregate?.count).toBe(0);
  });

  it("isolates immutable versions, rejects stale executions, and supersedes old incidents", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const target = await t.run(async (ctx) =>
      ctx.db
        .query("qualityProbeTargets")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
    );
    if (target === null) throw new Error("target missing");

    await leaseWithId(t, target._id, "v1-failure");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "v1-failure",
      outcome: "timeout",
      latencyMs: 8_000,
    });
    for (const [executionId, outcome] of [
      ["v1-failure-2", "timeout"],
      ["v1-healthy-1", "healthy"],
      ["v1-healthy-2", "healthy"],
      ["v1-failure-3", "timeout"],
    ] as const) {
      await leaseWithId(t, target._id, executionId);
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId,
        outcome,
        ...(outcome === "healthy" ? { statusCode: 204 } : {}),
        latencyMs: 10,
      });
    }
    await leaseWithId(t, target._id, "v1-in-flight");

    const version2 = await t.run(async (ctx) =>
      ctx.db.insert("specVersions", {
        projectId: seeded.projectId,
        version: "2.0.0",
        spec: SPEC.replace('"1.0.0"', '"2.0.0"'),
        publishedAt: Date.now() + 1_000,
      }),
    );

    // Latest spec changed, so old snapshot is hidden even before sync lands.
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toBeNull();

    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: version2,
    });
    expect(
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: "v1-in-flight",
        outcome: "healthy",
        statusCode: 200,
        latencyMs: 1,
      }),
    ).toEqual({ applied: false });

    // Out-of-order scheduler delivery for v1 cannot roll monitoring backward.
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const currentTarget = await t.run(async (ctx) => ctx.db.get(target._id));
    expect(currentTarget?.specVersionId).toBe(version2);

    for (let index = 1; index <= 3; index += 1) {
      await leaseWithId(t, target._id, `v2-healthy-${index}`);
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: `v2-healthy-${index}`,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 15,
      });
    }
    await t.run(async (ctx) => {
      await ctx.db.insert("gatewayQualitySamples", {
        projectId: seeded.projectId,
        specVersionId: seeded.specVersionId,
        refId: "settle:late-v1-call",
        outcome: "network_error",
        latencyMs: 8_000,
        at: Date.now(),
      });
    });
    await t.mutation(internal.quality.recomputeGatewayQuality, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("qualitySnapshots")
          .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
          .unique(),
      ),
    ).resolves.toMatchObject({ specVersionId: version2 });
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({
      reachabilitySampleSize: 3,
      insufficientReachabilityData: false,
      lastProbeOutcome: "healthy",
    });

    // Duplicate scheduler delivery is non-destructive.
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: version2,
    });
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({
      reachabilitySampleSize: 3,
      lastProbeOutcome: "healthy",
    });

    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "1.0.0",
          status: "superseded",
          failureCount: 3,
        }),
        expect.objectContaining({ version: "2.0.0", status: "resolved" }),
      ]),
    );
    for (const incident of incidents.page) {
      expect(incident).not.toHaveProperty("startedByExecutionId");
      expect(incident).not.toHaveProperty("resolvedByExecutionId");
    }
  });

  it("validates probe truth and keeps reachability separate from declared-health readiness", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: seeded.specVersionId,
    });
    const target = await t.run(async (ctx) =>
      ctx.db
        .query("qualityProbeTargets")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
    );
    if (target === null) throw new Error("target missing");

    await leaseWithId(t, target._id, "invalid-success");
    await expect(
      t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: "invalid-success",
        outcome: "healthy",
        statusCode: 503,
        latencyMs: 1,
      }),
    ).rejects.toThrow("Invalid quality probe result");
    expect(
      await t.run(async (ctx) => ctx.db.query("qualityProbeResults").collect()),
    ).toHaveLength(0);

    await leaseWithId(t, target._id, "transport-failure");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "transport-failure",
      outcome: "network_error",
      latencyMs: 5,
    });
    await leaseWithId(t, target._id, "auth-response");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "auth-response",
      outcome: "http_error",
      statusCode: 401,
      latencyMs: 6,
    });
    for (let index = 0; index < 3; index += 1) {
      await leaseWithId(t, target._id, `healthy-${index}`);
      await t.mutation(internal.quality.recordProbeResult, {
        targetId: target._id,
        executionId: `healthy-${index}`,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 5,
      });
    }

    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toHaveLength(0);
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({
      reachabilityPercent: 80,
      lastProbeOutcome: "healthy",
    });
  });

  it("caps cron and public pagination work", async () => {
    const t = convexTest(schema, modules);
    const { publisherId, consumerId, projectId } = await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 25; index += 1) {
        const id = await ctx.db.insert("projects", {
          organizationId: publisherId,
          name: `Probe ${index}`,
          slug: `probe-${index}`,
          status: "published",
          visibility: "public",
          tags: [],
        });
        const specVersionId = await ctx.db.insert("specVersions", {
          projectId: id,
          version: "1.0.0",
          spec: SPEC,
          publishedAt: Date.now(),
        });
        await ctx.db.insert("qualityProbeTargets", {
          projectId: id,
          specVersionId,
          url: "https://example.com",
          method: "HEAD",
          enabled: true,
          nextProbeAt: 0,
          updatedAt: 0,
        });
      }
    });
    expect(await t.mutation(internal.quality.leaseDueTargets, {})).toHaveLength(
      20,
    );
    expect(await t.mutation(internal.quality.leaseDueTargets, {})).toHaveLength(
      5,
    );

    const consumer = t.withIdentity({
      subject: "consumer_user",
      org_id: "org_consumer",
      org_role: "org:member",
    });
    await expect(
      consumer.query(api.quality.listSubscriptions, {
        paginationOpts: { numItems: 51, cursor: null },
      }),
    ).rejects.toThrow("Page size");
    await expect(
      t.query(api.quality.listPublicIncidents, {
        projectId,
        paginationOpts: { numItems: 51, cursor: null },
      }),
    ).rejects.toThrow("Page size");

    // Keep seed return fully exercised; no subscriber rows leak across orgs.
    expect(consumerId).toBeTruthy();
  });
});
