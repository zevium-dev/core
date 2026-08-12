/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedProject(
  t: TestConvex<typeof schema>,
  status: "draft" | "published",
) {
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
      name: "Lifecycle API",
      slug: "lifecycle-api",
      status,
      visibility: status === "published" ? "public" : "private",
      tags: [],
    });
    await ctx.db.insert("specs", { projectId, draft: "{}", lastSavedAt: 1 });
    const specVersionId = await ctx.db.insert("specVersions", {
      projectId,
      version: "1.0.0",
      spec: "{}",
      publishedAt: 1,
    });
    await ctx.db.insert("publishReadiness", {
      projectId,
      draftHash: "hash",
      healthCheckUrl: "https://example.com/health",
      healthCheckMethod: "HEAD",
      status: "ok",
      testedAt: 1,
    });
    await ctx.db.insert("qualityProbeTargets", {
      projectId,
      specVersionId,
      url: "https://example.com/health",
      method: "HEAD",
      enabled: true,
      nextProbeAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("qualityProbeResults", {
      projectId,
      specVersionId,
      executionId: "execution",
      checkedAt: 1,
      outcome: "healthy",
      statusCode: 204,
      latencyMs: 10,
    });
    for (let index = 0; index < 55; index += 1) {
      await ctx.db.insert("qualityProbeResults", {
        projectId,
        specVersionId,
        executionId: `boundary-execution-${index}`,
        checkedAt: index + 2,
        outcome: "healthy",
        statusCode: 204,
        latencyMs: 10,
      });
    }
    await ctx.db.insert("qualitySnapshots", {
      projectId,
      specVersionId,
      reachabilitySampleSize: 1,
      reachabilityResponseCount: 1,
      insufficientReachabilityData: true,
      apiSampleSize: 1,
      apiSuccessCount: 1,
      insufficientApiData: true,
      lastProbeOutcome: "healthy",
      lastProbedAt: 1,
      publishedAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("gatewayQualitySamples", {
      projectId,
      specVersionId,
      refId: "gateway-quality:lifecycle",
      outcome: "success",
      latencyMs: 10,
      at: 1,
    });
    await ctx.db.insert("qualityIncidents", {
      projectId,
      specVersionId,
      openedAt: 1,
      status: "resolved",
      closedAt: 2,
      startedByExecutionId: "execution",
      resolvedByExecutionId: "execution-2",
      failureCount: 3,
      lastOutcome: "healthy",
      reason: "test incident",
      restoreVisibility: status === "published" ? "public" : "private",
      threshold: 3,
      windowSize: 5,
      recoveryPasses: 3,
      restoredAt: 2,
      updatedAt: 2,
    });
    await ctx.db.insert("listingSubscriptions", {
      consumerOrganizationId: consumerId,
      projectId,
      active: true,
      createdBy: "consumer",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("listingSubscriptionAggregates", {
      projectId,
      count: 1,
      updatedAt: 1,
    });
    const reviewId = await ctx.db.insert("reviews", {
      projectId,
      consumerOrganizationId: consumerId,
      rating: 5,
      body: "Useful",
      active: true,
      hidden: false,
      createdBy: "consumer",
      updatedBy: "consumer",
      createdAt: 1,
      updatedAt: 1,
      sortKey: "0000000000000001:review",
    });
    await ctx.db.insert("reviewEdits", {
      reviewId,
      actorUserId: "consumer",
      action: "created",
      rating: 5,
      at: 1,
    });
    await ctx.db.insert("reviewReports", {
      reviewId,
      reporterUserId: "reporter",
      reason: "report reason",
      status: "open",
      createdAt: 1,
      sortKey: "0000000000000001:report",
    });
    await ctx.db.insert("reviewAggregates", {
      projectId,
      count: 1,
      ratingSum: 5,
      oneStar: 0,
      twoStar: 0,
      threeStar: 0,
      fourStar: 0,
      fiveStar: 1,
      updatedAt: 1,
    });
    const responseId = await ctx.db.insert("publisherReviewResponses", {
      reviewId,
      body: "Thanks",
      createdBy: "publisher",
      updatedBy: "publisher",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("publisherReviewResponseEdits", {
      responseId,
      actorUserId: "publisher",
      body: "Thanks",
      at: 1,
    });
    await ctx.db.insert("reviewModerationActions", {
      reviewId,
      action: "hidden",
      reason: "test",
      actorUserId: "admin",
      at: 1,
      sortKey: "0000000000000001:moderation",
    });
    await ctx.db.insert("specEmbeddings", {
      projectId,
      text: "lifecycle api",
      embedding: Array.from({ length: 768 }, () => 0),
      updatedAt: 1,
    });
    const webhookEndpointId = await ctx.db.insert("webhookEndpoints", {
      projectId,
      url: "https://hooks.example.com/zevium",
      secret: "test-secret",
      active: true,
      createdAt: 1,
    });
    let inFlightDeliveryId: Id<"webhookDeliveries"> | null = null;
    for (let index = 0; index < 55; index += 1) {
      const deliveryId = await ctx.db.insert("webhookDeliveries", {
        endpointId: webhookEndpointId,
        event: "project.updated",
        status: "pending",
        attempts: 0,
        createdAt: index + 1,
        payload: "{}",
      });
      if (index === 0) inFlightDeliveryId = deliveryId;
    }
    if (inFlightDeliveryId === null) throw new Error("delivery seed failed");
    await ctx.db.insert("usageEvents", {
      organizationId: consumerId,
      projectId,
      endpoint: "/x",
      method: "GET",
      credits: 1,
      status: 200,
      latencyMs: 10,
      keyId: "key",
      at: 1,
      settleRefId: "settle:lifecycle",
    });
    return {
      publisherId,
      projectId,
      specVersionId,
      inFlightDeliveryId,
    };
  });
}

function publisher(t: TestConvex<typeof schema>) {
  return t.withIdentity({
    subject: "publisher_user",
    org_id: "org_publisher",
    org_role: "org:admin",
  });
}

describe("project lifecycle retention", () => {
  it("retires published listings, disables probes, blocks gateway, and retains evidence", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedProject(t, "published");
    const retired = await publisher(t).mutation(api.projects.retire, {
      projectId: seeded.projectId,
    });
    expect(retired).toMatchObject({
      visibility: "private",
      qualityStatus: "suspended",
      qualitySuspensionReason: "Publisher permanently retired this listing",
    });
    expect(retired.retiredAt).toBeGreaterThan(0);
    const state = await t.run(async (ctx) => ({
      target: await ctx.db
        .query("qualityProbeTargets")
        .withIndex("by_project", (q) => q.eq("projectId", seeded.projectId))
        .unique(),
      reviews: await ctx.db.query("reviews").collect(),
      incidents: await ctx.db.query("qualityIncidents").collect(),
      samples: await ctx.db.query("gatewayQualitySamples").collect(),
      usage: await ctx.db.query("usageEvents").collect(),
    }));
    expect(state.target).toMatchObject({ enabled: false });
    expect(state.reviews).toHaveLength(1);
    expect(state.incidents).toHaveLength(1);
    expect(state.samples).toHaveLength(1);
    expect(state.usage).toHaveLength(1);
    const gatewayRoute = await t.query(
      internal.specs.getPublishedForGatewayInternal,
      {
        publisherHandle: "publisher",
        projectSlug: "lifecycle-api",
      },
    );
    expect(gatewayRoute?.retiredAt).toBeGreaterThan(0);
    await expect(
      publisher(t).mutation(api.projects.remove, {
        projectId: seeded.projectId,
      }),
    ).rejects.toThrow(/cannot be deleted|Project not found/);
    await expect(
      publisher(t).mutation(api.projects.update, {
        projectId: seeded.projectId,
        patch: { visibility: "public" },
      }),
    ).rejects.toThrow(/cannot be relisted|Project not found/);
  });

  it("cascades every project-scoped quality/review row for disposable drafts", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedProject(t, "draft");
    await publisher(t).mutation(api.projects.remove, {
      projectId: seeded.projectId,
    });
    await expect(
      t.query(internal.webhooks.getDeliveryForAction, {
        deliveryId: seeded.inFlightDeliveryId,
      }),
    ).resolves.toBeNull();
    for (let step = 0; step < 20; step += 1) {
      const result = await t.mutation(internal.projects.runProjectCleanupPage, {
        projectId: seeded.projectId,
      });
      if (result.phase === "finished") break;
    }
    const counts = await t.run(async (ctx) => ({
      project: await ctx.db.get(seeded.projectId),
      readiness: (await ctx.db.query("publishReadiness").collect()).length,
      targets: (await ctx.db.query("qualityProbeTargets").collect()).length,
      results: (await ctx.db.query("qualityProbeResults").collect()).length,
      snapshots: (await ctx.db.query("qualitySnapshots").collect()).length,
      samples: (await ctx.db.query("gatewayQualitySamples").collect()).length,
      incidents: (await ctx.db.query("qualityIncidents").collect()).length,
      subscriptions: (await ctx.db.query("listingSubscriptions").collect())
        .length,
      subscriptionAggregates: (
        await ctx.db.query("listingSubscriptionAggregates").collect()
      ).length,
      reviews: (await ctx.db.query("reviews").collect()).length,
      reports: (await ctx.db.query("reviewReports").collect()).length,
      reviewEdits: (await ctx.db.query("reviewEdits").collect()).length,
      reviewAggregates: (await ctx.db.query("reviewAggregates").collect())
        .length,
      responses: (await ctx.db.query("publisherReviewResponses").collect())
        .length,
      responseEdits: (
        await ctx.db.query("publisherReviewResponseEdits").collect()
      ).length,
      moderation: (await ctx.db.query("reviewModerationActions").collect())
        .length,
      usage: (await ctx.db.query("usageEvents").collect()).length,
      embeddings: (await ctx.db.query("specEmbeddings").collect()).length,
      webhookEndpoints: (await ctx.db.query("webhookEndpoints").collect())
        .length,
      webhookDeliveries: (await ctx.db.query("webhookDeliveries").collect())
        .length,
    }));
    expect(counts).toEqual({
      project: expect.objectContaining({
        _id: seeded.projectId,
        deletionState: "cleaned",
        retiredAt: expect.any(Number),
      }),
      readiness: 0,
      targets: 0,
      results: 0,
      snapshots: 0,
      samples: 0,
      incidents: 0,
      subscriptions: 0,
      subscriptionAggregates: 0,
      reviews: 0,
      reports: 0,
      reviewEdits: 0,
      reviewAggregates: 0,
      responses: 0,
      responseEdits: 0,
      moderation: 0,
      usage: 1,
      embeddings: 0,
      webhookEndpoints: 0,
      webhookDeliveries: 0,
    });
  });
});
