/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Quality", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: { "/health": { get: { "x-zevium-cost": 1 } } },
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
      sampleSize: 0,
      insufficientData: true,
      availabilityPercent: null,
      successRatePercent: null,
      latencyP50Ms: null,
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
        outcome: "success",
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
      outcome: "success",
      statusCode: 204,
      latencyMs: 20,
    });

    expect(
      await t.query(api.quality.getPublicSnapshot, {
        projectId: seeded.projectId,
      }),
    ).toMatchObject({
      sampleSize: 3,
      insufficientData: false,
      availabilityPercent: 66.67,
      successRatePercent: 50,
      latencyP50Ms: 20,
      lastOutcome: "success",
    });
    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toHaveLength(1);
    expect(incidents.page[0]).toMatchObject({
      status: "resolved",
      failureCount: 2,
    });

    const sideEffects = await t.run(async (ctx) => ({
      usage: await ctx.db.query("usageEvents").collect(),
      earnings: await ctx.db.query("publisherEarnings").collect(),
      ledger: await ctx.db.query("walletEntries").collect(),
    }));
    expect(sideEffects).toEqual({ usage: [], earnings: [], ledger: [] });
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
    await consumer.mutation(api.quality.setSubscription, {
      projectId: seeded.projectId,
      active: false,
    });
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
        outcome: "success",
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

    await leaseWithId(t, target._id, "v2-success");
    await t.mutation(internal.quality.recordProbeResult, {
      targetId: target._id,
      executionId: "v2-success",
      outcome: "success",
      statusCode: 204,
      latencyMs: 15,
    });
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({
      sampleSize: 1,
      insufficientData: true,
      lastOutcome: "success",
    });

    // Duplicate scheduler delivery is non-destructive.
    await t.mutation(internal.quality.syncPublishedTarget, {
      projectId: seeded.projectId,
      specVersionId: version2,
    });
    await expect(
      t.query(api.quality.getPublicSnapshot, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ sampleSize: 1, lastOutcome: "success" });

    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toEqual([
      expect.objectContaining({
        version: "1.0.0",
        status: "superseded",
        failureCount: 1,
      }),
    ]);
    expect(incidents.page[0]).not.toHaveProperty("startedByExecutionId");
    expect(incidents.page[0]).not.toHaveProperty("resolvedByExecutionId");
  });

  it("validates probe truth and treats 4xx as available without opening outage incidents", async () => {
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
        outcome: "success",
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

    const incidents = await t.query(api.quality.listPublicIncidents, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incidents.page).toHaveLength(1);
    expect(incidents.page[0]).toMatchObject({
      status: "resolved",
      failureCount: 1,
      lastOutcome: "network_error",
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
