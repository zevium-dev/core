/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
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
        billingOutcome: "settled",
        qualityOutcome: "success",
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
      for (const billingOutcome of ["refunded", "free"] as const) {
        await ctx.db.insert("usageEvents", {
          organizationId: seeded.otherId,
          projectId: seeded.projectId,
          endpoint: `/${billingOutcome}`,
          method: "GET",
          credits: 0,
          status: 200,
          latencyMs: 1,
          keyId: "gateway-key",
          at: Date.now(),
          settleRefId: `settle:${billingOutcome}`,
          billingOutcome,
          qualityOutcome: "success",
        });
      }
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
      t
        .withIdentity({ subject: "other", org_id: "org_other" })
        .query(api.reviews.getViewerState, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ canReview: false });
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
      expectedModerationGeneration: review.moderationGeneration ?? 0,
      expectedContentRevision: review.contentRevision ?? 0,
    });
    const edited = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 1,
      body: "Edited while hidden",
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 0, averageRating: null });

    const restored = await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Content now acceptable",
      expectedModerationGeneration: (review.moderationGeneration ?? 0) + 1,
      expectedContentRevision: edited.contentRevision ?? 0,
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Idempotent retry",
      expectedModerationGeneration: restored.moderationGeneration ?? 0,
      expectedContentRevision: restored.contentRevision ?? 0,
    });
    await expect(
      t.query(api.reviews.getAggregate, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ count: 1, averageRating: 1 });

    const withdrawn = await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Hide withdrawn review",
      expectedModerationGeneration: restored.moderationGeneration ?? 0,
      expectedContentRevision: withdrawn.contentRevision ?? 0,
    });
    const reactivated = await consumer.mutation(api.reviews.upsert, {
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
      expectedModerationGeneration: reactivated.moderationGeneration ?? 0,
      expectedContentRevision: reactivated.contentRevision ?? 0,
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
    const currentReview = await t.run(async (ctx) => ctx.db.get(review._id));
    if (currentReview === null) throw new Error("review missing");

    const admin = t.withIdentity({ subject: "admin_user" });
    await expect(
      admin.mutation(api.reviews.moderate, {
        reviewId: review._id,
        action: "hidden",
        reason: "x",
        expectedModerationGeneration: currentReview.moderationGeneration ?? 0,
        expectedContentRevision: currentReview.contentRevision ?? 0,
      }),
    ).rejects.toThrow("at least 3");
    const hidden = await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Contains abusive content",
      expectedModerationGeneration: currentReview.moderationGeneration ?? 0,
      expectedContentRevision: currentReview.contentRevision ?? 0,
    });
    expect(
      (await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }))
        .count,
    ).toBe(0);
    const hiddenReviews = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      limit: 10,
    });
    expect(hiddenReviews.page).toHaveLength(0);
    const duplicate = await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Duplicate moderation",
      expectedModerationGeneration: hidden.moderationGeneration ?? 0,
      expectedContentRevision: hidden.contentRevision ?? 0,
    });
    expect(duplicate.hidden).toBe(true);
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Appeal accepted",
      expectedModerationGeneration: hidden.moderationGeneration ?? 0,
      expectedContentRevision: hidden.contentRevision ?? 0,
    });
    expect(
      (await t.query(api.reviews.getAggregate, { projectId: seeded.projectId }))
        .count,
    ).toBe(1);
    const visible = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      limit: 10,
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
      limit: 10,
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
        limit: 51,
      }),
    ).rejects.toThrow("Page size");
  });

  it("exposes eligibility, reports, and recoverable admin queues behind role gates", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const consumer = t.withIdentity(consumerIdentity);
    const publisher = t.withIdentity(publisherIdentity);
    const other = t.withIdentity({
      subject: "other_user",
      org_id: "org_other",
    });
    const admin = t.withIdentity({ subject: "admin_user" });
    const review = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 4,
      body: "Accurate but slow",
    });

    await expect(
      t.query(api.reviews.getViewerState, { projectId: seeded.projectId }),
    ).resolves.toMatchObject({ signedIn: false, canReview: false });
    await expect(
      consumer.query(api.reviews.getViewerState, {
        projectId: seeded.projectId,
      }),
    ).resolves.toMatchObject({ signedIn: true, canReview: true });
    await expect(
      publisher.query(api.reviews.getViewerState, {
        projectId: seeded.projectId,
      }),
    ).resolves.toMatchObject({ isPublisher: true, canReview: false });

    await expect(
      consumer.mutation(api.reviews.report, {
        reviewId: review._id,
        reason: "This is my own review and should fail",
      }),
    ).rejects.toThrow("cannot report");
    await expect(
      other.mutation(api.reviews.report, {
        reviewId: review._id,
        reason: "Contains a claim needing moderator review",
      }),
    ).resolves.toEqual({ reported: true });
    await expect(
      other.mutation(api.reviews.report, {
        reviewId: review._id,
        reason: "Contains a claim needing moderator review",
      }),
    ).resolves.toEqual({ reported: false });
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 1,
      body: "Replacement text",
    });
    await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    await expect(
      admin.query(api.reviews.listModerationQueue, { mode: "reported" }),
    ).resolves.toMatchObject({
      page: [
        expect.objectContaining({
          item: expect.objectContaining({
            rating: 1,
            body: "Replacement text",
            active: false,
          }),
        }),
      ],
    });
    await publisher.mutation(api.reviews.respondAsPublisher, {
      reviewId: review._id,
      body: "Publisher response",
    });
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 1,
      body: "Replacement text",
    });
    await expect(
      consumer.query(api.reviews.listModerationQueue, {
        mode: "reported",
      }),
    ).rejects.toThrow("Not authorized as admin");

    const reported = await admin.query(api.reviews.listModerationQueue, {
      mode: "reported",
    });
    expect(reported.page[0]).toMatchObject({
      kind: "review",
      item: {
        reviewId: review._id,
        projectName: "Reviewed API",
        publisherName: "Publisher",
        reportCount: 1,
        response: { body: "Publisher response" },
        expectedModerationGeneration: expect.any(Number),
        expectedContentRevision: expect.any(Number),
      },
    });
    expect(JSON.stringify(reported)).not.toContain("org_consumer");
    const queuedReview = await t.run(async (ctx) => ctx.db.get(review._id));
    if (queuedReview === null) throw new Error("review missing");
    await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 2,
      body: "Newer content after queue load",
    });
    await expect(
      admin.mutation(api.reviews.moderate, {
        reviewId: review._id,
        action: "hidden",
        reason: "Stale queue action",
        expectedModerationGeneration: queuedReview.moderationGeneration ?? 0,
        expectedContentRevision: queuedReview.contentRevision ?? 0,
      }),
    ).rejects.toThrow("stale");
    const currentReview = await t.run(async (ctx) => ctx.db.get(review._id));
    if (currentReview === null) throw new Error("review missing");
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Investigating reported claim",
      expectedModerationGeneration: currentReview.moderationGeneration ?? 0,
      expectedContentRevision: currentReview.contentRevision ?? 0,
    });
    await expect(
      admin.query(api.reviews.listModerationQueue, { mode: "reported" }),
    ).resolves.toMatchObject({ page: [] });
    await expect(
      admin.query(api.reviews.listModerationQueue, { mode: "hidden" }),
    ).resolves.toMatchObject({
      page: [
        expect.objectContaining({
          item: expect.objectContaining({ reviewId: review._id }),
        }),
      ],
    });
    await expect(
      admin.mutation(api.reviews.moderate, {
        reviewId: review._id,
        action: "restored",
        reason: "Stale generation action",
        expectedModerationGeneration: currentReview.moderationGeneration ?? 0,
        expectedContentRevision: currentReview.contentRevision ?? 0,
      }),
    ).rejects.toThrow("stale");
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Claim is acceptable",
      expectedModerationGeneration:
        (currentReview.moderationGeneration ?? 0) + 1,
      expectedContentRevision: currentReview.contentRevision ?? 0,
    });
    const history = await admin.query(api.reviews.listModerationQueue, {
      mode: "history",
    });
    expect(history.page.map((row) => row.kind)).toEqual(["history", "history"]);
  });

  it("preserves report generations through edits/reactivation and resumes more than 50 resolutions", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t);
    const consumer = t.withIdentity(consumerIdentity);
    const other = t.withIdentity({
      subject: "other_user",
      org_id: "org_other",
    });
    const admin = t.withIdentity({ subject: "admin_user" });
    const review = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 3,
      body: "Needs moderation",
    });

    await expect(
      other.mutation(api.reviews.report, {
        reviewId: review._id,
        reason: "Original report before review edits",
      }),
    ).resolves.toEqual({ reported: true });
    const edited = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 2,
      body: "Edited after the first report",
    });
    expect(edited.moderationGeneration).toBe(review.moderationGeneration);
    await consumer.mutation(api.reviews.withdraw, {
      projectId: seeded.projectId,
    });
    const reactivated = await consumer.mutation(api.reviews.upsert, {
      projectId: seeded.projectId,
      rating: 2,
      body: "Reactivated after the first report",
    });
    expect(reactivated.moderationGeneration).toBe(review.moderationGeneration);

    await t.run(async (ctx) => {
      for (let index = 1; index < 75; index += 1) {
        await ctx.db.insert("reviewReports", {
          reviewId: review._id,
          reporterUserId: `legacy_reporter_${index}`,
          reason: `Original report ${index}`,
          status: "open",
          createdAt: index + 1,
          sortKey: `${String(index + 1).padStart(16, "0")}:original-${index}`,
          moderationGeneration: review.moderationGeneration,
        });
      }
      const thread = await ctx.db
        .query("reviewReportThreads")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .unique();
      if (thread === null) throw new Error("report thread missing");
      await ctx.db.patch(thread._id, {
        openCount: 75,
        latestReason: "Original report 74",
        latestReportedAt: 75,
        latestSortKey: `${String(75).padStart(16, "0")}:original-74`,
        rating: reactivated.rating,
        body: reactivated.body,
        active: true,
        hidden: false,
        updatedAt: 75,
      });
      await ctx.db.patch(review._id, { openReportCount: 75 });
    });

    const hidden = await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "hidden",
      reason: "Investigating original reports",
      expectedModerationGeneration: reactivated.moderationGeneration ?? 0,
      expectedContentRevision: reactivated.contentRevision ?? 0,
    });
    await admin.mutation(api.reviews.moderate, {
      reviewId: review._id,
      action: "restored",
      reason: "Original reports reviewed",
      expectedModerationGeneration: hidden.moderationGeneration ?? 0,
      expectedContentRevision: hidden.contentRevision ?? 0,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("organizations", {
        clerkOrgId: "org_future_reporter",
        name: "Future reporter",
        slug: "future-reporter",
      });
    });
    await expect(
      t
        .withIdentity({
          subject: "future_reporter",
          org_id: "org_future_reporter",
        })
        .mutation(api.reviews.report, {
          reviewId: review._id,
          reason: "New evidence after the moderation decision",
        }),
    ).resolves.toEqual({ reported: true });

    const resumed = await t.mutation(internal.reviews.resolveReportsPage, {
      reviewId: review._id,
      actorUserId: "admin_user",
      moderationGeneration: review.moderationGeneration,
    });
    expect(resumed).toEqual({ resolved: 25, done: true });
    await expect(
      t.mutation(internal.reviews.resolveReportsPage, {
        reviewId: review._id,
        actorUserId: "admin_user",
        moderationGeneration: review.moderationGeneration,
      }),
    ).resolves.toEqual({ resolved: 0, done: true });
    const remaining = await t.run(async (ctx) => ({
      review: await ctx.db.get(review._id),
      reports: await ctx.db
        .query("reviewReports")
        .withIndex("by_review_status", (q) =>
          q.eq("reviewId", review._id).eq("status", "open"),
        )
        .collect(),
      thread: await ctx.db
        .query("reviewReportThreads")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .unique(),
    }));
    expect(remaining.reports).toHaveLength(1);
    expect(remaining.reports[0]?.reason).toContain("New evidence");
    expect(remaining.reports[0]?.moderationGeneration).toBe(
      (review.moderationGeneration ?? 0) + 2,
    );
    expect(remaining.review?.openReportCount).toBe(1);
    expect(remaining.thread).toMatchObject({ openCount: 1, status: "open" });
  });

  it("uses immutable filter-bound keysets for public review pages", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seed(t, false);
    const ids = await t.run(async (ctx) => {
      const created: Id<"reviews">[] = [];
      for (let index = 1; index <= 3; index += 1) {
        const organizationId = await ctx.db.insert("organizations", {
          clerkOrgId: `org_page_${index}`,
          name: `Page ${index}`,
          slug: `page-${index}`,
        });
        created.push(
          await ctx.db.insert("reviews", {
            projectId: seeded.projectId,
            consumerOrganizationId: organizationId,
            rating: index,
            body: `Review ${index}`,
            active: true,
            hidden: false,
            createdBy: `user_${index}`,
            updatedBy: `user_${index}`,
            createdAt: index,
            updatedAt: index,
            sortKey: `${String(index).padStart(16, "0")}:fixed-${index}`,
          }),
        );
      }
      return created;
    });
    const first = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      limit: 2,
    });
    expect(first.page.map((review) => review.body)).toEqual([
      "Review 3",
      "Review 2",
    ]);
    expect(first.nextCursor).toBeTruthy();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[1]!, {
        updatedAt: 99_999,
        body: "Edited review 2",
      });
    });
    const second = await t.query(api.reviews.listPublic, {
      projectId: seeded.projectId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.page.map((review) => review.body)).toEqual(["Review 1"]);
    const otherProject = await t.run(async (ctx) =>
      ctx.db.insert("projects", {
        organizationId: seeded.publisherId,
        name: "Other",
        slug: "other",
        status: "published",
        visibility: "public",
        tags: [],
      }),
    );
    await expect(
      t.query(api.reviews.listPublic, {
        projectId: otherProject,
        limit: 2,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow("does not match");
  });
});
