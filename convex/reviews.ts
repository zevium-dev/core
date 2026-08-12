import type {
  PublicReviewContract,
  ReviewAggregateContract,
} from "@zevium/shared";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireAdmin,
  requireIdentity,
  requireProjectMember,
} from "./lib/auth";
import { decodeKeysetCursor, encodeKeysetCursor } from "./lib/keysetCursor";
import { internal } from "./_generated/api";

const MAX_REVIEW_LENGTH = 2_000;
const MAX_RESPONSE_LENGTH = 2_000;
const MAX_MODERATION_REASON_LENGTH = 1_000;
const MAX_REPORT_REASON_LENGTH = 1_000;
const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 50;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const REPORTS_PER_WINDOW = 10;
const REPORT_RESOLUTION_PAGE_SIZE = 50;

type DbCtx = MutationCtx | QueryCtx;
type QueueMode = "active" | "hidden" | "reported" | "history";
type CursorPayload = { version: 1; scope: string; sortKey: string };

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

async function settledUsageForReview(
  ctx: DbCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
) {
  return await ctx.db
    .query("usageEvents")
    .withIndex("by_org_project_billing_settlement", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("projectId", projectId)
        .eq("billingOutcome", "settled")
        .gte("settleRefId", "settle:")
        .lt("settleRefId", "settle;"),
    )
    .first();
}

function pageSize(value: number | undefined): number {
  const size = value ?? PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(size) || size < 1 || size > PAGE_SIZE_MAX) {
    throw new Error(`Page size must be between 1 and ${PAGE_SIZE_MAX}`);
  }
  return size;
}

function isPublicListing(
  project: Doc<"projects"> | null,
): project is Doc<"projects"> {
  return (
    project !== null &&
    project.status === "published" &&
    project.visibility === "public" &&
    project.retiredAt === undefined &&
    project.qualityStatus !== "suspended" &&
    project.qualityStatus !== "recovering"
  );
}

function sortKey(now = Date.now()): string {
  return `${String(now).padStart(16, "0")}:${crypto.randomUUID()}`;
}

function readCursor(cursor: string | undefined, scope: string): string | null {
  if (cursor === undefined || cursor === "") return null;
  const parsed = decodeKeysetCursor<CursorPayload>(cursor);
  if (
    parsed.version !== 1 ||
    parsed.scope !== scope ||
    typeof parsed.sortKey !== "string" ||
    parsed.sortKey === ""
  ) {
    throw new Error("Cursor does not match current filters");
  }
  return parsed.sortKey;
}

function nextCursor(
  scope: string,
  rows: Array<{ sortKey: string }>,
  size: number,
): string | null {
  return rows.length > size
    ? encodeKeysetCursor({
        version: 1,
        scope,
        sortKey: rows[size - 1]!.sortKey,
      } satisfies CursorPayload)
    : null;
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

function nextContentRevision(current: number | undefined): number {
  const next = (current ?? 0) + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Review content revision exhausted");
  }
  return next;
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

/** Keep every open moderation report pointed at current review truth. */
async function refreshOpenReportThread(
  ctx: MutationCtx,
  reviewId: Id<"reviews">,
  updatedAt: number,
): Promise<void> {
  const [review, thread] = await Promise.all([
    ctx.db.get(reviewId),
    ctx.db
      .query("reviewReportThreads")
      .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
      .unique(),
  ]);
  if (review === null || thread === null || thread.status !== "open") return;
  await ctx.db.patch(thread._id, {
    rating: review.rating,
    body: review.body,
    active: review.active,
    hidden: review.hidden,
    projectName: review.projectName ?? thread.projectName,
    publisherName: review.publisherName ?? thread.publisherName,
    responseBody: review.responseBody,
    responseUpdatedAt: review.responseUpdatedAt,
    moderationGeneration: review.moderationGeneration,
    contentRevision: review.contentRevision,
    updatedAt,
  });
}

async function requireEligibleReviewer(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const { claims, org } = await activeOrg(ctx);
  const project = await ctx.db.get(projectId);
  if (!isPublicListing(project)) {
    throw new Error("Published listing not found");
  }
  if (project.organizationId === org._id) {
    throw new Error("Publisher organizations cannot review their own listing");
  }
  const settledUsage = await settledUsageForReview(ctx, org._id, projectId);
  if (settledUsage === null) {
    throw new Error(
      "A settled call from this organization is required before reviewing",
    );
  }
  return { claims, org };
}

function publicReview(review: Doc<"reviews">): PublicReviewContract {
  return {
    id: review._id,
    rating: normalizeRating(review.rating),
    body: review.body ?? null,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    reviewerLabel: "Verified consumer",
    response:
      review.responseBody === undefined
        ? null
        : {
            body: review.responseBody,
            updatedAt: review.responseUpdatedAt ?? review.updatedAt,
          },
  };
}

/** Create, edit, or reactivate active consumer org's one review per listing. */
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
      const nextRevision = nextContentRevision(existing.contentRevision);
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
        sortKey: existing.sortKey,
        responseBody: existing.responseBody,
        responseUpdatedAt: existing.responseUpdatedAt,
        projectName: existing.projectName,
        publisherName: existing.publisherName,
        openReportCount: existing.openReportCount,
        latestReportReason: existing.latestReportReason,
        latestReportAt: existing.latestReportAt,
        latestModerationAction: existing.latestModerationAction,
        latestModerationReason: existing.latestModerationReason,
        latestModerationAt: existing.latestModerationAt,
        moderationGeneration: existing.moderationGeneration,
        contentRevision: nextRevision,
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
      await refreshOpenReportThread(ctx, existing._id, now);
      return (await ctx.db.get(existing._id))!;
    }
    const project = await ctx.db.get(args.projectId);
    if (project === null) throw new Error("Project not found");
    const publisher = await ctx.db.get(project.organizationId);
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
      sortKey: sortKey(now),
      moderationGeneration: 1,
      contentRevision: 1,
      projectName: project.name,
      publisherName: publisher?.name ?? "Unavailable publisher",
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
      contentRevision: nextContentRevision(review.contentRevision),
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
    await refreshOpenReportThread(ctx, review._id, now);
    return (await ctx.db.get(review._id))!;
  },
});

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
      await ctx.db.patch(review._id, {
        responseBody: body,
        responseUpdatedAt: now,
        updatedBy: claims.subject,
        updatedAt: now,
        contentRevision: nextContentRevision(review.contentRevision),
      });
      await ctx.db.insert("publisherReviewResponseEdits", {
        responseId: existing._id,
        actorUserId: claims.subject,
        previousBody: existing.body,
        body,
        at: now,
      });
      await refreshOpenReportThread(ctx, review._id, now);
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
    await ctx.db.patch(review._id, {
      responseBody: body,
      responseUpdatedAt: now,
      updatedBy: claims.subject,
      updatedAt: now,
      contentRevision: nextContentRevision(review.contentRevision),
    });
    await ctx.db.insert("publisherReviewResponseEdits", {
      responseId,
      actorUserId: claims.subject,
      body,
      at: now,
    });
    await refreshOpenReportThread(ctx, review._id, now);
    return (await ctx.db.get(responseId))!;
  },
});

export const report = mutation({
  args: { reviewId: v.id("reviews"), reason: v.string() },
  handler: async (ctx, args): Promise<{ reported: boolean }> => {
    const { claims, org } = await activeOrg(ctx);
    const review = await ctx.db.get(args.reviewId);
    if (review === null || !review.active || review.hidden) {
      throw new Error("Review is not available");
    }
    const project = await ctx.db.get(review.projectId);
    if (!isPublicListing(project)) {
      throw new Error("Published listing not found");
    }
    if (review.consumerOrganizationId === org._id) {
      throw new Error("You cannot report your organization's review");
    }
    if (project.organizationId === org._id) {
      throw new Error("Publishers cannot report reviews on their own listing");
    }
    const reason = args.reason.trim();
    if (reason.length < 10)
      throw new Error("Report reason must be at least 10 characters");
    if (reason.length > MAX_REPORT_REASON_LENGTH) {
      throw new Error(
        `Report reason must be at most ${MAX_REPORT_REASON_LENGTH} characters`,
      );
    }
    const existingForOrganization = await ctx.db
      .query("reviewReports")
      .withIndex("by_reporter_org_review", (q) =>
        q.eq("reporterOrganizationId", org._id).eq("reviewId", review._id),
      )
      .order("desc")
      .first();
    const legacyExisting =
      existingForOrganization === null
        ? await ctx.db
            .query("reviewReports")
            .withIndex("by_reporter_review", (q) =>
              q.eq("reporterUserId", claims.subject).eq("reviewId", review._id),
            )
            .first()
        : null;
    if (existingForOrganization !== null || legacyExisting !== null) {
      return { reported: false };
    }
    const now = Date.now();
    const recentReports = await ctx.db
      .query("reviewReports")
      .withIndex("by_reporter_org_created", (q) =>
        q
          .eq("reporterOrganizationId", org._id)
          .gte("createdAt", now - REPORT_WINDOW_MS),
      )
      .take(REPORTS_PER_WINDOW);
    if (recentReports.length >= REPORTS_PER_WINDOW) {
      throw new Error("Report rate limit reached. Try again later");
    }
    const reportSortKey = sortKey(now);
    await ctx.db.insert("reviewReports", {
      reviewId: review._id,
      reporterUserId: claims.subject,
      reporterOrganizationId: org._id,
      reason,
      status: "open",
      createdAt: now,
      sortKey: reportSortKey,
      moderationGeneration: review.moderationGeneration,
    });
    const thread = await ctx.db
      .query("reviewReportThreads")
      .withIndex("by_review", (q) => q.eq("reviewId", review._id))
      .unique();
    const threadValue = {
      reviewId: review._id,
      openCount: (thread?.openCount ?? 0) + 1,
      latestReason: reason,
      latestReportedAt: now,
      latestSortKey: reportSortKey,
      queueSortKey:
        thread?.status === "open" ? thread.queueSortKey : reportSortKey,
      rating: review.rating,
      body: review.body,
      active: review.active,
      hidden: review.hidden,
      reviewCreatedAt: review.createdAt,
      projectName: review.projectName ?? project.name,
      publisherName: review.publisherName ?? "Unavailable publisher",
      responseBody: review.responseBody,
      responseUpdatedAt: review.responseUpdatedAt,
      moderationGeneration: review.moderationGeneration,
      contentRevision: review.contentRevision,
      status: "open" as const,
      updatedAt: now,
    };
    if (thread === null)
      await ctx.db.insert("reviewReportThreads", threadValue);
    else await ctx.db.replace(thread._id, threadValue);
    await ctx.db.patch(review._id, {
      // Thread count includes older generations still draining in scheduled
      // pages. Review count tracks only reports since latest moderation.
      openReportCount: (review.openReportCount ?? 0) + 1,
      latestReportReason: reason,
      latestReportAt: now,
    });
    return { reported: true };
  },
});

export const moderate = mutation({
  args: {
    reviewId: v.id("reviews"),
    action: v.union(v.literal("hidden"), v.literal("restored")),
    reason: v.string(),
    expectedModerationGeneration: v.number(),
    expectedContentRevision: v.number(),
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
    const currentModerationGeneration = review.moderationGeneration ?? 0;
    const currentContentRevision = review.contentRevision ?? 0;
    if (
      args.expectedModerationGeneration !== currentModerationGeneration ||
      args.expectedContentRevision !== currentContentRevision
    ) {
      throw new Error("Moderation target is stale; refresh the queue");
    }
    const hidden = args.action === "hidden";
    if (review.hidden === hidden) return review;
    const now = Date.now();
    const reportGeneration = review.moderationGeneration;
    const nextModerationGeneration = (reportGeneration ?? 0) + 1;
    if (!Number.isSafeInteger(nextModerationGeneration)) {
      throw new Error("Review moderation generation exhausted");
    }
    await ctx.db.patch(review._id, {
      hidden,
      moderationGeneration: nextModerationGeneration,
    });
    await ctx.db.insert("reviewModerationActions", {
      reviewId: review._id,
      action: args.action,
      reason,
      actorUserId: admin.subject,
      at: now,
      sortKey: sortKey(now),
      rating: review.rating,
      body: review.body,
      projectName: review.projectName,
      publisherName: review.publisherName,
      active: review.active,
      hidden,
      reviewCreatedAt: review.createdAt,
      responseBody: review.responseBody,
      responseUpdatedAt: review.responseUpdatedAt,
      reportCount: review.openReportCount ?? 0,
      latestReportReason: review.latestReportReason,
      latestReportAt: review.latestReportAt,
    });
    await ctx.db.patch(review._id, {
      latestModerationAction: args.action,
      latestModerationReason: reason,
      latestModerationAt: now,
      openReportCount: 0,
    });
    const reports = await ctx.db
      .query("reviewReports")
      .withIndex("by_review_status_generation", (q) =>
        q
          .eq("reviewId", review._id)
          .eq("status", "open")
          .eq("moderationGeneration", reportGeneration),
      )
      .take(REPORT_RESOLUTION_PAGE_SIZE);
    for (const reportRow of reports) {
      await ctx.db.patch(reportRow._id, {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: admin.subject,
      });
    }
    const thread = await ctx.db
      .query("reviewReportThreads")
      .withIndex("by_review", (q) => q.eq("reviewId", review._id))
      .unique();
    if (thread !== null) {
      await ctx.db.patch(thread._id, {
        openCount: Math.max(0, thread.openCount - reports.length),
        status:
          Math.max(0, thread.openCount - reports.length) === 0
            ? "resolved"
            : "open",
        updatedAt: now,
      });
    }
    await refreshOpenReportThread(ctx, review._id, now);
    if (reports.length === REPORT_RESOLUTION_PAGE_SIZE) {
      await ctx.scheduler.runAfter(0, internal.reviews.resolveReportsPage, {
        reviewId: review._id,
        actorUserId: admin.subject,
        moderationGeneration: reportGeneration,
      });
    }
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

export const resolveReportsPage = internalMutation({
  args: {
    reviewId: v.id("reviews"),
    actorUserId: v.string(),
    moderationGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ resolved: number; done: boolean }> => {
    const rows = await ctx.db
      .query("reviewReports")
      .withIndex("by_review_status_generation", (q) =>
        q
          .eq("reviewId", args.reviewId)
          .eq("status", "open")
          .eq("moderationGeneration", args.moderationGeneration),
      )
      .take(REPORT_RESOLUTION_PAGE_SIZE);
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: args.actorUserId,
      });
    }
    const done = rows.length < REPORT_RESOLUTION_PAGE_SIZE;
    const thread = await ctx.db
      .query("reviewReportThreads")
      .withIndex("by_review", (q) => q.eq("reviewId", args.reviewId))
      .unique();
    if (thread !== null) {
      const nextOpenCount = Math.max(0, thread.openCount - rows.length);
      await ctx.db.patch(thread._id, {
        openCount: nextOpenCount,
        status: nextOpenCount === 0 ? "resolved" : "open",
        updatedAt: now,
      });
    }
    if (!done)
      await ctx.scheduler.runAfter(
        0,
        internal.reviews.resolveReportsPage,
        args,
      );
    return { resolved: rows.length, done };
  },
});

export const getAggregate = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<ReviewAggregateContract> => {
    const project = await ctx.db.get(args.projectId);
    if (!isPublicListing(project)) {
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
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const size = pageSize(args.limit);
    const scope = `public:${args.projectId}`;
    const after = readCursor(args.cursor, scope);
    const project = await ctx.db.get(args.projectId);
    if (!isPublicListing(project)) {
      return { page: [], nextCursor: null };
    }
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_project_visible", (q) => {
        const range = q
          .eq("projectId", args.projectId)
          .eq("active", true)
          .eq("hidden", false);
        return after === null ? range : range.lt("sortKey", after);
      })
      .order("desc")
      .take(size + 1);
    const page = rows.slice(0, size).map(publicReview);
    return { page, nextCursor: nextCursor(scope, rows, size) };
  },
});

export const listPublicPaginated = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > PAGE_SIZE_MAX
    ) {
      throw new Error(`Page size must be between 1 and ${PAGE_SIZE_MAX}`);
    }
    const project = await ctx.db.get(args.projectId);
    if (!isPublicListing(project)) {
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
    return { ...result, page: result.page.map(publicReview) };
  },
});

export const getViewerState = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return {
        signedIn: false,
        canReview: false,
        isPublisher: false,
        reason: "Sign in and choose an organization to review",
        review: null,
      };
    }
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) {
      return {
        signedIn: true,
        canReview: false,
        isPublisher: false,
        reason: "Choose an organization to review",
        review: null,
      };
    }
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    const project = await ctx.db.get(args.projectId);
    if (org === null || !isPublicListing(project)) {
      return {
        signedIn: true,
        canReview: false,
        isPublisher: false,
        reason: "Active organization is unavailable",
        review: null,
      };
    }
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    const isPublisher = project.organizationId === org._id;
    if (isPublisher) {
      return {
        signedIn: true,
        canReview: false,
        isPublisher: true,
        reason: "Publisher organizations cannot review their own listing",
        review,
      };
    }
    const usage = await settledUsageForReview(ctx, org._id, args.projectId);
    return {
      signedIn: true,
      canReview: usage !== null,
      isPublisher: false,
      reason:
        usage === null
          ? "Make one settled gateway call before reviewing"
          : review?.active
            ? "Your verified review is published"
            : "Eligible verified consumer",
      review,
    };
  },
});

function queueReview(review: Doc<"reviews">) {
  return {
    reviewId: review._id,
    rating: normalizeRating(review.rating),
    body: review.body ?? null,
    active: review.active,
    hidden: review.hidden,
    createdAt: review.createdAt,
    projectName: review.projectName ?? "Unavailable project",
    publisherName: review.publisherName ?? "Unavailable publisher",
    response:
      review.responseBody === undefined
        ? null
        : {
            body: review.responseBody,
            updatedAt: review.responseUpdatedAt ?? review.updatedAt,
          },
    reportCount: review.openReportCount ?? 0,
    expectedModerationGeneration: review.moderationGeneration ?? 0,
    expectedContentRevision: review.contentRevision ?? 0,
    reports:
      review.latestReportReason === undefined
        ? []
        : [
            {
              reason: review.latestReportReason,
              at: review.latestReportAt ?? review.updatedAt,
            },
          ],
    latestAction:
      review.latestModerationAction === undefined
        ? null
        : {
            action: review.latestModerationAction,
            reason: review.latestModerationReason ?? "Moderated",
            at: review.latestModerationAt ?? review.updatedAt,
          },
  };
}

function reportedQueueReview(
  thread: Doc<"reviewReportThreads">,
  currentReview: Doc<"reviews"> | null,
) {
  const rating = currentReview?.rating ?? thread.rating;
  const body = currentReview === null ? thread.body : currentReview.body;
  const active = currentReview?.active ?? thread.active;
  const hidden = currentReview?.hidden ?? thread.hidden;
  const responseBody =
    currentReview === null ? thread.responseBody : currentReview.responseBody;
  const responseUpdatedAt =
    currentReview === null
      ? thread.responseUpdatedAt
      : currentReview.responseUpdatedAt;
  return {
    reviewId: thread.reviewId,
    rating: normalizeRating(rating),
    body: body ?? null,
    active,
    hidden,
    createdAt: currentReview?.createdAt ?? thread.reviewCreatedAt,
    projectName: currentReview?.projectName ?? thread.projectName,
    publisherName: currentReview?.publisherName ?? thread.publisherName,
    response:
      responseBody === undefined
        ? null
        : {
            body: responseBody,
            updatedAt: responseUpdatedAt ?? thread.updatedAt,
          },
    reportCount: thread.openCount,
    expectedModerationGeneration: currentReview?.moderationGeneration ?? 0,
    expectedContentRevision: currentReview?.contentRevision ?? 0,
    reports: [{ reason: thread.latestReason, at: thread.latestReportedAt }],
    latestAction: null,
  };
}

function historyQueueReview(action: Doc<"reviewModerationActions">) {
  if (action.rating === undefined) return null;
  return {
    reviewId: action.reviewId,
    rating: normalizeRating(action.rating),
    body: action.body ?? null,
    active: action.active ?? true,
    hidden: action.hidden ?? action.action === "hidden",
    createdAt: action.reviewCreatedAt ?? action.at,
    projectName: action.projectName ?? "Unavailable project",
    publisherName: action.publisherName ?? "Unavailable publisher",
    response:
      action.responseBody === undefined
        ? null
        : {
            body: action.responseBody,
            updatedAt: action.responseUpdatedAt ?? action.at,
          },
    reportCount: action.reportCount ?? 0,
    expectedModerationGeneration: 0,
    expectedContentRevision: 0,
    reports:
      action.latestReportReason === undefined
        ? []
        : [
            {
              reason: action.latestReportReason,
              at: action.latestReportAt ?? action.at,
            },
          ],
    latestAction: {
      action: action.action,
      reason: action.reason,
      at: action.at,
    },
  };
}

export const listModerationQueue = query({
  args: {
    mode: v.union(
      v.literal("active"),
      v.literal("hidden"),
      v.literal("reported"),
      v.literal("history"),
    ),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const size = pageSize(args.limit);
    const mode: QueueMode = args.mode;
    const scope = `admin:${mode}`;
    const after = readCursor(args.cursor, scope);
    if (mode === "history") {
      const rows = await ctx.db
        .query("reviewModerationActions")
        .withIndex("by_sort", (q) =>
          after === null ? q : q.lt("sortKey", after),
        )
        .order("desc")
        .take(size + 1);
      const page = rows.slice(0, size).map((action) => ({
        kind: "history" as const,
        action,
        item: historyQueueReview(action),
      }));
      return { page, nextCursor: nextCursor(scope, rows, size) };
    }
    if (mode === "reported") {
      const reports = await ctx.db
        .query("reviewReportThreads")
        .withIndex("by_status_sort", (q) => {
          const range = q.eq("status", "open");
          return after === null ? range : range.lt("queueSortKey", after);
        })
        .order("desc")
        .take(size + 1);
      const page = await Promise.all(
        reports.slice(0, size).map(async (reportRow) => ({
          kind: "review" as const,
          report: {
            reason: reportRow.latestReason,
            at: reportRow.latestReportedAt,
          },
          item: reportedQueueReview(
            reportRow,
            await ctx.db.get(reportRow.reviewId),
          ),
        })),
      );
      return {
        page,
        nextCursor:
          reports.length > size
            ? encodeKeysetCursor({
                version: 1,
                scope,
                sortKey: reports[size - 1]!.queueSortKey,
              } satisfies CursorPayload)
            : null,
      };
    }
    const hidden = mode === "hidden";
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_active_hidden_sort", (q) => {
        const range = q.eq("active", true).eq("hidden", hidden);
        return after === null ? range : range.lt("sortKey", after);
      })
      .order("desc")
      .take(size + 1);
    const page = rows.slice(0, size).map((review) => ({
      kind: "review" as const,
      report: null,
      item: queueReview(review),
    }));
    return { page, nextCursor: nextCursor(scope, rows, size) };
  },
});

export const moderationHistory = query({
  args: {
    reviewId: v.id("reviews"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const size = pageSize(args.limit);
    const scope = `history:${args.reviewId}`;
    const after = readCursor(args.cursor, scope);
    const rows = await ctx.db
      .query("reviewModerationActions")
      .withIndex("by_review_sort", (q) => {
        const range = q.eq("reviewId", args.reviewId);
        return after === null ? range : range.lt("sortKey", after);
      })
      .order("desc")
      .take(size + 1);
    return {
      page: rows.slice(0, size),
      nextCursor: nextCursor(scope, rows, size),
    };
  },
});
