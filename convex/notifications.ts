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
};

/**
 * Paginated notifications for the caller's org, newest first.
 * Includes unreadCount across all notifications (not just this page).
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

    // Count unread — bounded scan of the by_org index (readAt undefined).
    // This is a background/dashboard query, not a hot path.
    const unreadRows = await ctx.db
      .query("notifications")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .filter((q) => q.eq(q.field("readAt"), undefined))
      .collect();

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
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<{ updated: number }> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const now = Date.now();
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .filter((q) => q.eq(q.field("readAt"), undefined))
      .collect();
    for (const n of unread) {
      await ctx.db.patch(n._id, { readAt: now });
    }
    return { updated: unread.length };
  },
});
