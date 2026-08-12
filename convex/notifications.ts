import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireOrgMemberBySlug } from "./lib/auth";

export type NotificationView = {
  _id: Id<"notifications">;
  kind: Doc<"notifications">["kind"];
  title: string;
  body: string;
  refId: string;
  readAt: number | undefined;
  createdAt: number;
};

export type NotificationsPage = {
  page: NotificationView[];
  isDone: boolean;
  continueCursor: string;
  unreadCount: number;
  unreadCountCapped: boolean;
};

const UNREAD_BATCH_SIZE = 100;

/**
 * Paginated notifications for the caller's org, newest first.
 * Includes an exact unread count up to the UI's 99+ display threshold.
 * The indexed `take` keeps this realtime query bounded for noisy orgs.
 */
export const listForOrg = query({
  args: {
    orgSlug: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<NotificationsPage> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const result = await ctx.db
      .query("notifications")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .order("desc")
      .paginate(args.paginationOpts);

    const unreadRows = await ctx.db
      .query("notifications")
      .withIndex("by_org_read", (q) =>
        q.eq("clerkOrgId", org.clerkOrgId).eq("readAt", undefined),
      )
      .take(UNREAD_BATCH_SIZE);

    return {
      page: result.page.map((n) => ({
        _id: n._id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        refId: n.refId,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      unreadCount: unreadRows.length,
      unreadCountCapped: unreadRows.length === UNREAD_BATCH_SIZE,
    };
  },
});

/**
 * Mark a single notification as read. Must belong to caller's org.
 */
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) {
      throw new Error("No active organization on identity");
    }
    const notification = await ctx.db.get(args.notificationId);
    if (notification === null) {
      throw new Error("Notification not found");
    }
    if (notification.clerkOrgId !== claims.orgId) {
      throw new Error("Not a member of this organization");
    }
    if (notification.readAt !== undefined) return { ok: true };
    await ctx.db.patch(args.notificationId, { readAt: Date.now() });
    return { ok: true };
  },
});

/**
 * Mark all unread notifications as read for the caller's org.
 */
export const markAllRead = mutation({
  args: { orgSlug: v.string(), through: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; hasMore: boolean; through: number }> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    // First batch captures server time. Follow-up batches reuse it so new
    // notifications stay unread and client clock skew cannot move the cutoff.
    const through = args.through ?? now;
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org_read", (q) =>
        q
          .eq("clerkOrgId", org.clerkOrgId)
          .eq("readAt", undefined)
          .lte("createdAt", through),
      )
      .take(UNREAD_BATCH_SIZE);
    for (const n of unread) {
      await ctx.db.patch(n._id, { readAt: now });
    }
    const hasMore =
      unread.length === UNREAD_BATCH_SIZE &&
      (await ctx.db
        .query("notifications")
        .withIndex("by_org_read", (q) =>
          q
            .eq("clerkOrgId", org.clerkOrgId)
            .eq("readAt", undefined)
            .lte("createdAt", through),
        )
        .first()) !== null;
    return { updated: unread.length, hasMore, through };
  },
});
