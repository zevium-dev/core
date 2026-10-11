import { paginationOptsValidator } from "convex/server";
import { v, ConvexError } from "convex/values";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import {
  query,
  mutation,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireActiveOrg,
  requireProjectMember,
  requireAdmin,
} from "./lib/auth";
import { listing } from "./lib/catalogue";
const limiter = new RateLimiter(components.rateLimiter, {
  reports: { kind: "token bucket", rate: 10, period: HOUR, capacity: 10 },
});
const sortKey = () =>
  `${String(Date.now()).padStart(16, "0")}:${crypto.randomUUID()}`;
const content = (
  r: Pick<Doc<"reviews">, "rating" | "body" | "active" | "hidden">,
) => ({ rating: r.rating, body: r.body, active: r.active, hidden: r.hidden });
const publicReview = (r: Doc<"reviews">) => ({
  id: r._id,
  rating: r.rating,
  body: r.body ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  reviewerLabel: "Verified consumer",
  response: r.response
    ? { body: r.response.body, updatedAt: r.response.updatedAt }
    : null,
});
function text(value: string, min: number, max: number, label: string) {
  const result = value.trim();
  if (result.length < min || result.length > max)
    throw new ConvexError(`${label} must be ${min}–${max} characters`);
  return result;
}
async function eligible(ctx: QueryCtx, projectId: Id<"projects">) {
  const active = await requireActiveOrg(ctx),
    project = await ctx.db.get(projectId);
  if (!project || !(await listing(ctx, project)))
    throw new ConvexError("Listing unavailable");
  if (project.organizationId === active.org._id)
    throw new ConvexError(
      "Publisher organizations cannot review their own listing",
    );
  const row = await ctx.db
    .query("usageRollups")
    .withIndex("by_consumer_project", (q) =>
      q
        .eq("kind", "lifetime_consumer_project")
        .eq("consumerOrganizationId", active.org._id)
        .eq("projectId", projectId),
    )
    .unique();
  if (row?.kind !== "lifetime_consumer_project" || row.successfulCalls < 1)
    throw new ConvexError("Make one successful gateway call before reviewing");
  return active;
}
async function aggregate(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  before: Doc<"reviews"> | null,
  after: Doc<"reviews">,
) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError("Listing unavailable");
  const summary = {
      ...project.reviewSummary,
      distribution: { ...project.reviewSummary.distribution },
    },
    keys = ["one", "two", "three", "four", "five"] as const;
  for (const [row, delta] of [
    [before, -1],
    [after, 1],
  ] as const)
    if (row?.active && !row.hidden) {
      summary.count += delta;
      summary.ratingSum += delta * row.rating;
      summary.distribution[keys[row.rating - 1]!] += delta;
    }
  await ctx.db.patch(projectId, { reviewSummary: summary });
}
export const upsert = mutation({
  args: {
    projectId: v.id("projects"),
    rating: v.number(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { org, claims } = await eligible(ctx, args.projectId);
    if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5)
      throw new ConvexError("Rating must be 1–5");
    const body =
      args.body === undefined
        ? undefined
        : text(args.body, 0, 2000, "Review") || undefined;
    const before = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    if (before?.active && before.rating === args.rating && before.body === body)
      return before;
    const now = Date.now();
    const id = before
      ? before._id
      : await ctx.db.insert("reviews", {
          projectId: args.projectId,
          consumerOrganizationId: org._id,
          rating: args.rating,
          body,
          active: true,
          hidden: false,
          createdBy: claims.subject,
          updatedBy: claims.subject,
          createdAt: now,
          updatedAt: now,
          sortKey: sortKey(),
          contentRevision: 1,
          moderationGeneration: 1,
          openReportCount: 0,
          hasOpenReports: false,
        });
    if (before)
      await ctx.db.patch(id, {
        rating: args.rating,
        body,
        active: true,
        updatedBy: claims.subject,
        updatedAt: now,
        contentRevision: before.contentRevision + 1,
      });
    const after = (await ctx.db.get(id))!;
    await ctx.db.insert("reviewEvents", {
      kind: "edit",
      reviewId: id,
      actorUserId: claims.subject,
      at: now,
      sortKey: sortKey(),
      contentRevision: after.contentRevision,
      moderationGeneration: after.moderationGeneration,
      previous: before
        ? content(before)
        : { rating: args.rating, active: false, hidden: false },
      current: content(after),
    });
    await aggregate(ctx, args.projectId, before, after);
    return after;
  },
});
export const withdraw = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    const before = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    if (!before) throw new ConvexError("Review not found");
    if (!before.active) return before;
    await ctx.db.patch(before._id, {
      active: false,
      contentRevision: before.contentRevision + 1,
      updatedBy: claims.subject,
      updatedAt: Date.now(),
    });
    const after = (await ctx.db.get(before._id))!;
    await ctx.db.insert("reviewEvents", {
      kind: "edit",
      reviewId: before._id,
      actorUserId: claims.subject,
      at: Date.now(),
      sortKey: sortKey(),
      contentRevision: after.contentRevision,
      moderationGeneration: after.moderationGeneration,
      previous: content(before),
      current: content(after),
    });
    await aggregate(ctx, args.projectId, before, after);
    return after;
  },
});
export const respondAsPublisher = mutation({
  args: { reviewId: v.id("reviews"), body: v.string() },
  handler: async (ctx, args) => {
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new ConvexError("Review not found");
    const { claims } = await requireProjectMember(ctx, review.projectId),
      body = text(args.body, 1, 2000, "Response");
    if (review.response?.body === body) return review.response;
    const response = {
      body,
      createdBy: review.response?.createdBy ?? claims.subject,
      updatedBy: claims.subject,
      createdAt: review.response?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await ctx.db.patch(review._id, {
      response,
      contentRevision: review.contentRevision + 1,
    });
    await ctx.db.insert("reviewEvents", {
      kind: "response_edit",
      reviewId: review._id,
      actorUserId: claims.subject,
      at: Date.now(),
      sortKey: sortKey(),
      contentRevision: review.contentRevision + 1,
      moderationGeneration: review.moderationGeneration,
      previous: review.response?.body ?? null,
      current: body,
    });
    return response;
  },
});
export const report = mutation({
  args: { reviewId: v.id("reviews"), reason: v.string() },
  handler: async (ctx, args) => {
    const { claims, org } = await requireActiveOrg(ctx),
      review = await ctx.db.get(args.reviewId),
      reason = text(args.reason, 10, 1000, "Reason");
    const project = review && (await ctx.db.get(review.projectId));
    if (
      !review?.active ||
      review.hidden ||
      !project ||
      !(await listing(ctx, project)) ||
      review.consumerOrganizationId === org._id ||
      project.organizationId === org._id
    )
      throw new ConvexError("Review cannot be reported by this organization");
    const previous = await ctx.db
      .query("reviewEvents")
      .withIndex("by_reporter_review", (q) =>
        q
          .eq("actorOrganizationId", org._id)
          .eq("reviewId", review._id)
          .eq("kind", "report"),
      )
      .order("desc")
      .first();
    if (previous?.moderationGeneration === review.moderationGeneration)
      return { reported: false };
    if (!(await limiter.limit(ctx, "reports", { key: org._id })).ok)
      throw new ConvexError("Report limit reached. Try again later.");
    await ctx.db.insert("reviewEvents", {
      kind: "report",
      reviewId: review._id,
      actorUserId: claims.subject,
      actorOrganizationId: org._id,
      at: Date.now(),
      sortKey: sortKey(),
      contentRevision: review.contentRevision,
      moderationGeneration: review.moderationGeneration,
      reason,
      status: "open",
    });
    await ctx.db.patch(review._id, {
      openReportCount: review.openReportCount + 1,
      hasOpenReports: true,
      queueSortKey: review.queueSortKey ?? sortKey(),
      latestReportReason: reason,
      latestReportAt: Date.now(),
    });
    return { reported: true };
  },
});
export const resolveReportsPage = internalMutation({
  args: { reviewId: v.id("reviews"), moderationGeneration: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const rows = await ctx.db
      .query("reviewEvents")
      .withIndex("by_review_status", (q) =>
        q
          .eq("reviewId", args.reviewId)
          .eq("kind", "report")
          .eq("status", "open")
          .eq("moderationGeneration", args.moderationGeneration),
      )
      .take(50);
    for (const row of rows)
      await ctx.db.patch(row._id, {
        status: "resolved",
        resolvedAt: Date.now(),
      });
    if (rows.length === 50)
      await ctx.scheduler.runAfter(
        0,
        internal.reviews.resolveReportsPage,
        args,
      );
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
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx),
      reason = text(args.reason, 3, 1000, "Reason"),
      review = await ctx.db.get(args.reviewId);
    if (!review) throw new ConvexError("Review not found");
    if (
      review.moderationGeneration !== args.expectedModerationGeneration ||
      review.contentRevision !== args.expectedContentRevision
    )
      throw new ConvexError("Moderation target is stale; refresh the queue");
    const display = await queueItem(ctx, review);
    const hidden = args.action === "hidden";
    if (review.hidden === hidden) return review;
    await ctx.db.patch(review._id, {
      hidden,
      moderationGeneration: review.moderationGeneration + 1,
      openReportCount: 0,
      hasOpenReports: false,
      queueSortKey: undefined,
    });
    const after = (await ctx.db.get(review._id))!;
    await ctx.db.insert("reviewEvents", {
      kind: "moderation",
      reviewId: review._id,
      actorUserId: actor.subject,
      at: Date.now(),
      sortKey: sortKey(),
      contentRevision: review.contentRevision,
      moderationGeneration: after.moderationGeneration,
      action: hidden ? "hide" : "restore",
      reason,
      snapshot: content(after),
      display: {
        createdAt: display.createdAt,
        projectName: display.projectName,
        publisherName: display.publisherName,
        response: display.response,
        reportCount: display.reportCount,
        reports: display.reports,
      },
    });
    await ctx.scheduler.runAfter(0, internal.reviews.resolveReportsPage, {
      reviewId: review._id,
      moderationGeneration: review.moderationGeneration,
    });
    await aggregate(ctx, review.projectId, review, after);
    return after;
  },
});
export const getAggregate = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId),
      summary =
        project && (await listing(ctx, project)) ? project.reviewSummary : null;
    return {
      count: summary?.count ?? 0,
      averageRating: summary?.count ? summary.ratingSum / summary.count : null,
      distribution: {
        1: summary?.distribution.one ?? 0,
        2: summary?.distribution.two ?? 0,
        3: summary?.distribution.three ?? 0,
        4: summary?.distribution.four ?? 0,
        5: summary?.distribution.five ?? 0,
      },
    };
  },
});
export const listPublicPaginated = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || !(await listing(ctx, project)))
      return { page: [], isDone: true, continueCursor: "" };
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_public", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("active", true)
          .eq("hidden", false),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
        maximumRowsRead: 51,
      });
    return { ...rows, page: rows.page.map(publicReview) };
  },
});
export const getViewerState = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity)
      return {
        signedIn: false,
        canReview: false,
        isPublisher: false,
        reason: "Sign in and choose an organization to review",
        review: null,
      };
    let active;
    try {
      active = await requireActiveOrg(ctx);
    } catch {
      return {
        signedIn: true,
        canReview: false,
        isPublisher: false,
        reason: "Active organization is unavailable",
        review: null,
      };
    }
    const project = await ctx.db.get(args.projectId);
    if (!project || !(await listing(ctx, project)))
      return {
        signedIn: true,
        canReview: false,
        isPublisher: false,
        reason: "Listing unavailable",
        review: null,
      };
    const review = await ctx.db
      .query("reviews")
      .withIndex("by_consumer_project", (q) =>
        q
          .eq("consumerOrganizationId", active.org._id)
          .eq("projectId", args.projectId),
      )
      .unique();
    const isPublisher = project.organizationId === active.org._id;
    let canReview = false;
    try {
      await eligible(ctx, args.projectId);
      canReview = true;
    } catch {
      /* Normal eligibility refusal, never expose internal errors. */
    }
    return {
      signedIn: true,
      canReview,
      isPublisher,
      reason: isPublisher
        ? "Publisher organizations cannot review their own listing"
        : canReview
          ? "Eligible verified consumer"
          : "Make one successful gateway call before reviewing",
      review,
    };
  },
});
async function queueItem(ctx: QueryCtx, review: Doc<"reviews">) {
  const project = await ctx.db.get(review.projectId),
    org = project && (await ctx.db.get(project.organizationId));
  const latest = await ctx.db
    .query("reviewEvents")
    .withIndex("by_review_kind_time", (q) =>
      q.eq("reviewId", review._id).eq("kind", "moderation"),
    )
    .order("desc")
    .first();
  return {
    reviewId: review._id,
    rating: review.rating,
    body: review.body ?? null,
    active: review.active,
    hidden: review.hidden,
    createdAt: review.createdAt,
    projectName: project?.name ?? "Unavailable project",
    publisherName: org?.name ?? "Unavailable publisher",
    response: publicReview(review).response,
    reportCount: review.openReportCount,
    expectedModerationGeneration: review.moderationGeneration,
    expectedContentRevision: review.contentRevision,
    reports: review.latestReportReason
      ? [
          {
            reason: review.latestReportReason,
            at: review.latestReportAt ?? review.updatedAt,
          },
        ]
      : [],
    latestAction:
      latest?.kind === "moderation"
        ? {
            action:
              latest.action === "hide"
                ? ("hidden" as const)
                : ("restored" as const),
            reason: latest.reason,
            at: latest.at,
          }
        : null,
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
    const opts = {
      cursor: args.cursor ?? null,
      numItems: Math.min(50, Math.max(1, args.limit ?? 20)),
      maximumRowsRead: 51,
    };
    if (args.mode === "history") {
      const rows = await ctx.db
        .query("reviewEvents")
        .withIndex("by_kind_time", (q) => q.eq("kind", "moderation"))
        .order("desc")
        .paginate(opts);
      return {
        page: await Promise.all(
          rows.page.flatMap((e) =>
            e.kind === "moderation"
              ? [
                  (async () => {
                    const review = await ctx.db.get(e.reviewId);
                    return {
                      kind: "history" as const,
                      action: {
                        ...e,
                        action:
                          e.action === "hide"
                            ? ("hidden" as const)
                            : ("restored" as const),
                      },
                      item: review
                        ? {
                            reviewId: e.reviewId,
                            ...e.snapshot,
                            body: e.snapshot.body ?? null,
                            ...e.display,
                            expectedModerationGeneration:
                              e.moderationGeneration,
                            expectedContentRevision: e.contentRevision,
                            latestAction: {
                              action:
                                e.action === "hide"
                                  ? ("hidden" as const)
                                  : ("restored" as const),
                              reason: e.reason,
                              at: e.at,
                            },
                          }
                        : null,
                    };
                  })(),
                ]
              : [],
          ),
        ),
        nextCursor: rows.isDone ? null : rows.continueCursor,
      };
    }
    const source =
      args.mode === "reported"
        ? ctx.db
            .query("reviews")
            .withIndex("by_reported", (q) => q.eq("hasOpenReports", true))
        : ctx.db
            .query("reviews")
            .withIndex("by_state", (q) =>
              q.eq("active", true).eq("hidden", args.mode === "hidden"),
            );
    const rows = await source.order("desc").paginate(opts);
    return {
      page: await Promise.all(
        rows.page.map(async (review) => ({
          kind: "review" as const,
          report: null,
          item: await queueItem(ctx, review),
        })),
      ),
      nextCursor: rows.isDone ? null : rows.continueCursor,
    };
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
    const rows = await ctx.db
      .query("reviewEvents")
      .withIndex("by_review_kind_time", (q) =>
        q.eq("reviewId", args.reviewId).eq("kind", "moderation"),
      )
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(50, Math.max(1, args.limit ?? 20)),
        maximumRowsRead: 51,
      });
    return {
      page: rows.page,
      nextCursor: rows.isDone ? null : rows.continueCursor,
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
    const p = await ctx.db.get(args.projectId);
    if (!p || !(await listing(ctx, p))) return { page: [], nextCursor: null };
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_public", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("active", true)
          .eq("hidden", false),
      )
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(50, Math.max(1, args.limit ?? 20)),
        maximumRowsRead: 51,
      });
    return {
      page: rows.page.map(publicReview),
      nextCursor: rows.isDone ? null : rows.continueCursor,
    };
  },
});
