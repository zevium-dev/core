import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireOrgMemberBySlug } from "./lib/auth";
import {
  changeUnreadNotificationCount,
  clearUnreadNotificationCount,
} from "./lib/notifications";

const NOTIFICATION_PAGE_SIZE_MAX = 50;
const MARK_ALL_PAGE_SIZE = 100;

export type NotificationView = {
  _id: Id<"notifications">;
  kind: Doc<"notifications">["kind"];
  title: string;
  body: string;
  refId: string;
  publisherHandle: string | undefined;
  projectSlug: string | undefined;
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
    const numItems = Number.isSafeInteger(args.paginationOpts.numItems)
      ? Math.min(
          Math.max(args.paginationOpts.numItems, 1),
          NOTIFICATION_PAGE_SIZE_MAX,
        )
      : NOTIFICATION_PAGE_SIZE_MAX;

    const result = await ctx.db
      .query("notifications")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems,
        maximumRowsRead: NOTIFICATION_PAGE_SIZE_MAX + 1,
        maximumBytesRead: 256 * 1024,
      });

    const legacyUnread =
      org.unreadNotificationCount === undefined
        ? await ctx.db
            .query("notifications")
            .withIndex("by_org_read", (q) =>
              q.eq("clerkOrgId", org.clerkOrgId).eq("readAt", undefined),
            )
            .take(MARK_ALL_PAGE_SIZE)
        : null;

    return {
      page: result.page.map((n) => ({
        _id: n._id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        refId: n.refId,
        publisherHandle: n.publisherHandle,
        projectSlug: n.projectSlug,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      unreadCount: org.unreadNotificationCount ?? legacyUnread?.length ?? 0,
      unreadCountCapped:
        org.unreadNotificationCountCapped === true ||
        legacyUnread?.length === MARK_ALL_PAGE_SIZE,
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
    await changeUnreadNotificationCount(ctx, claims.orgId, -1);
    return { ok: true };
  },
});

/**
 * Mark all unread notifications as read for the caller's org.
 */
export const markAllRead = mutation({
  args: { orgSlug: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; complete: boolean }> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const result = await markUnreadPage(ctx, org.clerkOrgId);
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.notifications.markAllReadPage, {
        clerkOrgId: org.clerkOrgId,
      });
    }
    return result;
  },
});

async function markUnreadPage(
  ctx: MutationCtx,
  clerkOrgId: string,
): Promise<{ updated: number; complete: boolean }> {
  const now = Date.now();
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_org_read", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("readAt", undefined),
    )
    .take(MARK_ALL_PAGE_SIZE);
  for (const notification of unread) {
    await ctx.db.patch(notification._id, { readAt: now });
  }
  const complete = unread.length < MARK_ALL_PAGE_SIZE;
  if (complete) {
    await clearUnreadNotificationCount(ctx, clerkOrgId);
  } else {
    await changeUnreadNotificationCount(ctx, clerkOrgId, -unread.length);
  }
  return { updated: unread.length, complete };
}

export const markAllReadPage = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; complete: boolean }> => {
    const result = await markUnreadPage(ctx, args.clerkOrgId);
    if (!result.complete) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.markAllReadPage,
        args,
      );
    }
    return result;
  },
});
