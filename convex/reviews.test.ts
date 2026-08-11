/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: TestConvex<typeof schema>, withUsage = true) {
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
    const otherId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other",
      slug: "other",
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: publisherId,
      name: "Reviewed API",
      slug: "reviewed-api",
      status: "published",
      visibility: "public",
      tags: [],
    });
    if (withUsage) {
      await ctx.db.insert("usageEvents", {
        organizationId: consumerId,
        projectId,
        endpoint: "/used",
        method: "GET",
        credits: 1,
        status: 200,
        latencyMs: 10,
        keyId: "key",
        at: Date.now(),
        settleRefId: "settle:verified",
      });
    }
    return { publisherId, consumerId, otherId, projectId };
  });
}

const consumerIdentity = {
  subject: "consumer_user",
  org_id: "org_consumer",
  org_role: "org:member",
};
const publisherIdentity = {
  subject: "publisher_user",
  org_id: "org_publisher",
  org_role: "org:admin",
};

describe("verified reviews", () => {
  const priorAdmin = process.env.ADMIN_USER_IDS;
  beforeEach(() => {
    process.env.ADMIN_USER_IDS = "admin_user";
  });
  afterEach(() => {
    if (priorAdmin === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdmin;
  });

  it("rejects unauthenticated, unverified, self-review, and invalid ratings", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    await expect(
      t.mutation(api.reviews.upsert, {
        projectId: seeded.projectId,
        rating: 5,
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      t
        .withIdentity({ subject: "other", org_id: "org_other" })
        .mutation(api.reviews.upsert, {
          projectId: seeded.projectId,
          rating: 5,
        }),
    ).rejects.toThrow("settled call");
    await t.run(async (ctx) => {
      // Legacy analytics rows without gateway settlement proof cannot verify a
      // reviewer.
      await ctx.db.insert("usageEvents", {
        organizationId: seeded.otherId,
        projectId: seeded.projectId,
        endpoint: "/legacy",
        method: "GET",
        credits: 0,
        status: 200,
        latencyMs: 1,
        keyId: "legacy",
        at: Date.now(),
      });
    });
    await expect(
      t
        .withIdentity({ subject: "other", org_id: "org_other" })
        .mutation(api.reviews.upsert, {
          projectId: seeded.projectId,
          rating: 5,
        }),
    ).rejects.toThrow("settled call");
    await expect(
      t.withIdentity(publisherIdentity).mutation(api.reviews.upsert, {
        projectId: seeded.projectId,
        rating: 5,
      }),
    ).rejects.toThrow("own listing");
    await expect(
      t.withIdentity(consumerIdentity).mutation(api.reviews.upsert, {
        projectId: seeded.projectId,
        rating: 4.5,
      }),
    ).rejects.toThrow("integer");
  });

  it("normalizes empty text, keeps one review, audits edits, and derives exact aggregates", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const consumer = t.withIdentity(consumerIdentity);
    const created = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 5,
      body: "   ",
    });
    expect(created.body).toBeUndefined();
    const same = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 5,
    });
    expect(same._id).toBe(created._id);
    expect(
      await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).toEqual({
      count: 1,
      averageRating: 5,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
    });
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 2,
      body: "Changed after more use",
    });
    expect(
      await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).toEqual({
      count: 1,
      averageRating: 2,
      distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 },
    });
    const rows = await t.run(async (ctx) => ({
      reviews: await ctx.db.query("reviews").collect(),
      edits: await ctx.db
        .query("reviewEdits")
        .withIndex("by_review", (q) => q.eq("reviewId", created._id))
        .collect(),
    }));
    expect(rows.reviews).toHaveLength(1);
    expect(rows.edits.map((edit) => edit.action)).toEqual([
      "created",
      "edited",
    ]);

    await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    expect(
      (await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }))
        .count,
    ).toBe(0);
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 4,
    });
    expect(
      await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).toMatchObject({ count: 1, averageRating: 4 });
    const finalEdits = await t.run(async (ctx) =>
      ctx.db
        .query("reviewEdits")
        .withIndex("by_review", (q) => q.eq("reviewId", created._id))
        .collect(),
    );
    expect(finalEdits.map((edit) => edit.action)).toEqual([
      "created",
      "edited",
      "withdrawn",
      "reactivated",
    ]);
  });

  it("keeps hidden edits and reactivation out of aggregates until restored", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const consumer = t.withIdentity(consumerIdentity);
    const admin = t.withIdentity({ subject: "admin_user" });
    const review = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 5,
      body: "Initial",
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Needs moderation",
    });
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 1,
      body: "Edited while hidden",
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 0, averageRating: null });

    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Content now acceptable",
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Idempotent retry",
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 1, averageRating: 1 });

    await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Hide withdrawn review",
    });
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 3,
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 0, averageRating: null });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Restored after appeal",
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 1, averageRating: 3 });
  });

  it("supports non-deletable publisher responses and audited admin hide/restore", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const review = await t
      .withIdentity(consumerIdentity)
      .mutation(api.reviews.upsert, {
        projectId: seeded.projectId,
        rating: 4,
        body: "Useful",
      });
    await expect(
      t
        .withIdentity(consumerIdentity)
        .mutation(api.reviews.respondAsPublisher, {
          reviewId: review._id,
          body: "Thanks",
        }),
    ).rejects.toThrow("Not a member");
    await expect(
      t
        .withIdentity(publisherIdentity)
        .mutation(api.reviews.respondAsPublisher, {
          reviewId: review._id,
          body: "   ",
        }),
    ).rejects.toThrow("cannot be empty");
    const response = await t
      .withIdentity(publisherIdentity)
      .mutation(api.reviews.respondAsPublisher, {
        reviewId: review._id,
        body: "Thanks for testing it",
      });
    const edited = await t
      .withIdentity(publisherIdentity)
      .mutation(api.reviews.respondAsPublisher, {
        reviewId: review._id,
        body: "Thanks — issue fixed",
      });
    expect(edited._id).toBe(response._id);
    await t
      .withIdentity(publisherIdentity)
      .mutation(api.reviews.respondAsPublisher, {
        reviewId: review._id,
        body: "Thanks — issue fixed",
      });
    const responseAudit = await t.run(async (ctx) =>
      ctx.db
        .query("publisherReviewResponseEdits")
        .withIndex("by_response", (q) => q.eq("responseId", response._id))
        .collect(),
    );
    expect(responseAudit).toHaveLength(2);

    const admin = t.withIdentity({ subject: "admin_user" });
    await expect(
      admin.mutation(api.reviews.moderate, {
        reviewId: review._id,
        action: "hidden",
        reason: "x",
      }),
    ).rejects.toThrow("at least 3");
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Contains abusive content",
    });
    expect(
      (await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }))
        .count,
    ).toBe(0);
    const hidden = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(hidden.page).toHaveLength(0);
    const duplicate = await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Duplicate moderation",
    });
    expect(duplicate.hidden).toBe(true);
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Appeal accepted",
    });
    expect(
      (await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }))
        .count,
    ).toBe(1);
    const visible = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(visible.page).toEqual([
      expect.objectContaining({
        id: review._id,
        rating: 4,
        body: "Useful",
        reviewerLabel: "Verified consumer",
        response: {
          body: "Thanks — issue fixed",
          updatedAt: edited.updatedAt,
        },
      }),
    ]);
    expect(visible.page[0]).not.toHaveProperty("consumerOrganizationId");
    expect(visible.page[0]).not.toHaveProperty("consumerOrganizationName");
    const audit = await admin.query(api.reviews.moderationHistory, {
      reviewId: review._id,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(
      audit.page.map((row) => [row.action, row.actorUserId, row.reason]),
    ).toEqual([
      ["restored", "admin_user", "Appeal accepted"],
      ["hidden", "admin_user", "Contains abusive content"],
    ]);
    await expect(
      t.query(api.reviews.listPublic, {
        projectId: seeded.projectId,
        paginationOpts: { numItems: 51, cursor: null },
      }),
    ).rejects.toThrow("Page size");
  });
});
