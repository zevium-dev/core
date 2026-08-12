import type {
  PublicReviewContract,
  ReviewAggregateContract,
} from "@zevium/shared";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireAdmin,
  requireIdentity,
  requireProjectMember,
} from "./lib/auth";

const MAX_REVIEW_LENGTH = 2_000;
const MAX_RESPONSE_LENGTH = 2_000;
const MAX_MODERATION_REASON_LENGTH = 1_000;
const PAGE_SIZE_MAX = 50;

type DbCtx = MutationCtx | QueryCtx;

async function activeOrg(ctx: DbCtx) {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) throw new Error("Choose an organization first");
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (org === null) throw new Error("Active organization is not synchronized");
  return { claims, org };
}

function assertPageSize(numItems: number): void {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > PAGE_SIZE_MAX) {
    throw new Error(`Page size must be between 1 and ${PAGE_SIZE_MAX}`);
  }
}

function normalizeRating(value: number): PublicReviewContract["rating"] {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("Rating must be an integer from 1 to 5");
  }
  return value as PublicReviewContract["rating"];
}

function normalizeOptionalBody(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const body = value.trim();
  if (body.length > MAX_REVIEW_LENGTH) {
    throw new Error(`Review must be at most ${MAX_REVIEW_LENGTH} characters`);
  }
  return body === "" ? undefined : body;
}

function starField(
  rating: number,
): "oneStar" | "twoStar" | "threeStar" | "fourStar" | "fiveStar" {
  return (["oneStar", "twoStar", "threeStar", "fourStar", "fiveStar"] as const)[
    rating - 1
  ]!;
}

async function applyAggregateDelta(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  previousRating: number | undefined,
  nextRating: number | undefined,
): Promise<void> {
  if (previousRating === nextRating) return;
  const existing = await ctx.db
    .query("reviewAggregates")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  const aggregate = existing ?? {
    projectId,
    count: 0,
    ratingSum: 0,
    oneStar: 0,
    twoStar: 0,
    threeStar: 0,
    fourStar: 0,
    fiveStar: 0,
    updatedAt: 0,
  };
  const next = {
    projectId,
    count:
      aggregate.count +
      (nextRating === undefined ? 0 : 1) -
      (previousRating === undefined ? 0 : 1),
    ratingSum: aggregate.ratingSum + (nextRating ?? 0) - (previousRating ?? 0),
    oneStar: aggregate.oneStar,
    twoStar: aggregate.twoStar,
    threeStar: aggregate.threeStar,
    fourStar: aggregate.fourStar,
    fiveStar: aggregate.fiveStar,
    updatedAt: Date.now(),
  };
  if (previousRating !== undefined) next[starField(previousRating)] -= 1;
  if (nextRating !== undefined) next[starField(nextRating)] += 1;
  if (
    next.count < 0 ||
    next.ratingSum < 0 ||
    [
      next.oneStar,
      next.twoStar,
      next.threeStar,
      next.fourStar,
      next.fiveStar,
    ].some((count) => count < 0)
  ) {
    throw new Error("Review aggregate invariant failed");
  }
  if (existing) await ctx.db.replace(existing._id, next);
  else await ctx.db.insert("reviewAggregates", next);
}

async function requireEligibleReviewer(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const { claims, org } = await activeOrg(ctx);
  const project = await ctx.db.get(projectId);
  if (
    project === null ||
    project.status !== "published" ||
    project.visibility !== "public"
  ) {
    throw new Error("Published listing not found");
  }
  if (project.organizationId === org._id) {
    throw new Error("Publisher organizations cannot review their own listing");
  }
  const settledUsage = await ctx.db
    .query("usageEvents")
    .withIndex("by_org_project_settlement", (q) =>
      q
        .eq("organizationId", org._id)
        .eq("projectId", projectId)
        .gte("settleRefId", "settle:")
        .lt("settleRefId", "settle;"),
    )
    .first();
  if (settledUsage === null) {
    throw new Error(
      "A settled call from this organization is required before reviewing",
    );
  }
  return { claims, org, project };
}

/** Create, edit, or reactivate consumer org's single review for a listing. */
export const upsert = mutation({
  args: {
    projectId: v.id("projects"),
    rating: v.number(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"reviews">> => {
    const { claims, org } = await requireEligibleReviewer(ctx, args.projectId);
    const rating = normalizeRating(args.rating);
    const body = normalizeOptionalBody(args.body);
    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (
        existing.active &&
        existing.rating === rating &&
        existing.body === body
      )
        return existing;
      const wasVisible = existing.active && !existing.hidden;
      const willBeVisible = !existing.hidden;
      await ctx.db.replace(existing._id, {
        projectId: existing.projectId,
        consumerOrganizationId: existing.consumerOrganizationId,
        rating,
        body,
        active: true,
        hidden: existing.hidden,
        createdBy: existing.createdBy,
        createdAt: existing.createdAt,
        updatedBy: claims.subject,
        updatedAt: now,
      });
      await ctx.db.insert("reviewEdits", {
        reviewId: existing._id,
        actorUserId: claims.subject,
        action: existing.active ? "edited" : "reactivated",
        previousRating: existing.rating,
        previousBody: existing.body,
        rating,
        body,
        at: now,
      });
      await applyAggregateDelta(
        ctx,
        args.projectId,
        wasVisible ? existing.rating : undefined,
        willBeVisible ? rating : undefined,
      );
      return (await ctx.db.get(existing._id))!;
    }
    const reviewId = await ctx.db.insert("reviews", {
      projectId: args.projectId,
      consumerOrganizationId: org._id,
      rating,
      body,
      active: true,
      hidden: false,
      createdBy: claims.subject,
      updatedBy: claims.subject,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("reviewEdits", {
      reviewId,
      actorUserId: claims.subject,
      action: "created",
      rating,
      body,
      at: now,
    });
    await applyAggregateDelta(ctx, args.projectId, undefined, rating);
    return (await ctx.db.get(reviewId))!;
  },
});

export const withdraw = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Doc<"reviews">> => {
    const { claims, org } = await activeOrg(ctx);
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    if (review === null) throw new Error("Review not found");
    if (!review.active) return review;
    const now = Date.now();
    await ctx.db.patch(review._id, {
      active: false,
      updatedBy: claims.subject,
      updatedAt: now,
    });
    await ctx.db.insert("reviewEdits", {
      reviewId: review._id,
      actorUserId: claims.subject,
      action: "withdrawn",
      previousRating: review.rating,
      previousBody: review.body,
      at: now,
    });
    if (!review.hidden)
      await applyAggregateDelta(ctx, args.projectId, review.rating, undefined);
    return (await ctx.db.get(review._id))!;
  },
});

/** Publisher can create/edit a response. Deletion intentionally does not exist. */
export const respondAsPublisher = mutation({
  args: { reviewId: v.id("reviews"), body: v.string() },
  handler: async (ctx, args): Promise<Doc<"publisherReviewResponses">> => {
    const review = await ctx.db.get(args.reviewId);
    if (review === null) throw new Error("Review not found");
    const { claims } = await requireProjectMember(ctx, review.projectId);
    const body = args.body.trim();
    if (body === "") throw new Error("Publisher response cannot be empty");
    if (body.length > MAX_RESPONSE_LENGTH) {
      throw new Error(
        `Publisher response must be at most ${MAX_RESPONSE_LENGTH} characters`,
      );
    }
    const existing = await ctx.db
      .query("publisherReviewResponses")
      .withIndex("by_review", (q) => q.eq("reviewId", args.reviewId))
      .unique();
    const now = Date.now();
    if (existing) {
      if (existing.body === body) return existing;
      await ctx.db.patch(existing._id, {
        body,
        updatedBy: claims.subject,
        updatedAt: now,
      });
      await ctx.db.insert("publisherReviewResponseEdits", {
        responseId: existing._id,
        actorUserId: claims.subject,
        previousBody: existing.body,
        body,
        at: now,
      });
      return (await ctx.db.get(existing._id))!;
    }
    const responseId = await ctx.db.insert("publisherReviewResponses", {
      reviewId: args.reviewId,
      body,
      createdBy: claims.subject,
      updatedBy: claims.subject,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("publisherReviewResponseEdits", {
      responseId,
      actorUserId: claims.subject,
      body,
      at: now,
    });
    return (await ctx.db.get(responseId))!;
  },
});

export const moderate = mutation({
  args: {
    reviewId: v.id("reviews"),
    action: v.union(v.literal("hidden"), v.literal("restored")),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"reviews">> => {
    const admin = await requireAdmin(ctx);
    const reason = args.reason.trim();
    if (reason.length < 3)
      throw new Error("Moderation reason must be at least 3 characters");
    if (reason.length > MAX_MODERATION_REASON_LENGTH) {
      throw new Error(
        `Moderation reason must be at most ${MAX_MODERATION_REASON_LENGTH} characters`,
      );
    }
    const review = await ctx.db.get(args.reviewId);
    if (review === null) throw new Error("Review not found");
    const hidden = args.action === "hidden";
    // Same target state is a retry-safe no-op. No duplicate audit row or
    // aggregate delta is created.
    if (review.hidden === hidden) return review;
    const now = Date.now();
    await ctx.db.patch(review._id, { hidden });
    await ctx.db.insert("reviewModerationActions", {
      reviewId: review._id,
      action: args.action,
      reason,
      actorUserId: admin.subject,
      at: now,
    });
    if (review.active) {
      await applyAggregateDelta(
        ctx,
        review.projectId,
        hidden ? review.rating : undefined,
        hidden ? undefined : review.rating,
      );
    }
    return (await ctx.db.get(review._id))!;
  },
});

export const getAggregate = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ReviewAggregateContract> => {
    const project = await ctx.db.get(args.projectId);
    if (
      project === null ||
      project.status !== "published" ||
      project.visibility !== "public"
    ) {
      return {
        count: 0,
        averageRating: null,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }
    const row = await ctx.db
      .query("reviewAggregates")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (row === null || row.count === 0) {
      return {
        count: 0,
        averageRating: null,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }
    return {
      count: row.count,
      averageRating: Math.round((row.ratingSum / row.count) * 100) / 100,
      distribution: {
        1: row.oneStar,
        2: row.twoStar,
        3: row.threeStar,
        4: row.fourStar,
        5: row.fiveStar,
      },
    };
  },
});

export const listPublic = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    assertPageSize(args.paginationOpts.numItems);
    const project = await ctx.db.get(args.projectId);
    if (
      project === null ||
      project.status !== "published" ||
      project.visibility !== "public"
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("reviews")
      .withIndex("by_project_visible", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("active", true)
          .eq("hidden", false),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page: PublicReviewContract[] = [];
    for (const review of result.page) {
      const response = await ctx.db
        .query("publisherReviewResponses")
        .withIndex("by_review", (q) => q.eq("reviewId", review._id))
        .unique();
      page.push({
        id: review._id,
        rating: normalizeRating(review.rating),
        body: review.body ?? null,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
        // Public reviews prove paid use without exposing buyer org identity.
        reviewerLabel: "Verified consumer",
        response:
          response === null
            ? null
            : { body: response.body, updatedAt: response.updatedAt },
      });
    }
    return { ...result, page };
  },
});

export const getMine = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { org } = await activeOrg(ctx);
    return await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
  },
});

export const moderationHistory = query({
  args: {
    reviewId: v.id("reviews"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    assertPageSize(args.paginationOpts.numItems);
    return await ctx.db
      .query("reviewModerationActions")
      .withIndex("by_review", (q) => q.eq("reviewId", args.reviewId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
