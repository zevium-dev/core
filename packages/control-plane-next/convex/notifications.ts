import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireActiveOrg,
  requireOrgMemberBySlug,
  requireOrgAdmin,
} from "./lib/auth";
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

async function unreadCounts(
  ctx: QueryCtx,
  org: Doc<"organizations">,
  admin: boolean,
) {
  const unread = await ctx.db
    .query("notifications")
    .withIndex(admin ? "by_org_read" : "by_org_audience_read", (q) =>
      admin
        ? q.eq("organizationId", org._id).eq("readAt", undefined)
        : q
            .eq("organizationId", org._id)
            .eq("adminOnly", undefined)
            .eq("readAt", undefined),
    )
    .take(100);
  return {
    unreadCount: unread.length,
    unreadCountCapped: unread.length === 100,
  };
}

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
    const { org, access } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const numItems = Number.isSafeInteger(args.paginationOpts.numItems)
      ? Math.min(
          Math.max(args.paginationOpts.numItems, 1),
          NOTIFICATION_PAGE_SIZE_MAX,
        )
      : NOTIFICATION_PAGE_SIZE_MAX;

    const result = await ctx.db
      .query("notifications")
      .withIndex(
        access.capabilities.viewOrgUsage
          ? "by_org_time"
          : "by_org_audience_time",
        (q) =>
          access.capabilities.viewOrgUsage
            ? q.eq("organizationId", org._id)
            : q.eq("organizationId", org._id).eq("adminOnly", undefined),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems,
        maximumRowsRead: NOTIFICATION_PAGE_SIZE_MAX + 1,
        maximumBytesRead: 256 * 1024,
      });

    return {
      ...result,
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
      ...(await unreadCounts(ctx, org, access.capabilities.viewOrgUsage)),
    };
  },
});

/** The bell count covers the whole org, independently of loaded pages. */
export const unreadForOrg = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args) => {
    const { org, access } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    return unreadCounts(ctx, org, access.capabilities.viewOrgUsage);
  },
});

/**
 * Mark a single notification as read. Must belong to caller's org.
 */
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const { org, claims } = await requireActiveOrg(ctx);
    const notification = await ctx.db.get(args.notificationId);
    if (notification === null) {
      throw new Error("Notification not found");
    }
    if (notification.organizationId !== org._id) {
      throw new Error("Not a member of this organization");
    }
    if (notification.adminOnly) requireOrgAdmin(claims);
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
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; complete: boolean }> => {
    const { org, access } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const result = await markUnreadPage(
      ctx,
      org._id,
      access.capabilities.viewOrgUsage,
    );
    if (!result.complete) {
      await ctx.scheduler.runAfter(0, internal.notifications.markAllReadPage, {
        organizationId: org._id,
        admin: access.capabilities.viewOrgUsage,
      });
    }
    return result;
  },
});

async function markUnreadPage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  admin: boolean,
): Promise<{ updated: number; complete: boolean }> {
  const now = Date.now();
  const unread = await ctx.db
    .query("notifications")
    .withIndex(admin ? "by_org_read" : "by_org_audience_read", (q) =>
      admin
        ? q.eq("organizationId", organizationId).eq("readAt", undefined)
        : q
            .eq("organizationId", organizationId)
            .eq("adminOnly", undefined)
            .eq("readAt", undefined),
    )
    .take(MARK_ALL_PAGE_SIZE);
  for (const notification of unread) {
    await ctx.db.patch(notification._id, { readAt: now });
  }
  const complete = unread.length < MARK_ALL_PAGE_SIZE;
  return { updated: unread.length, complete };
}

export const markAllReadPage = internalMutation({
  args: { organizationId: v.id("organizations"), admin: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; complete: boolean }> => {
    const result = await markUnreadPage(ctx, args.organizationId, args.admin);
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

/** Per-user/per-org preference, scoped exclusively by the authenticated org. */
export const emailPreference = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args) => {
    const { claims, org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const preference = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", org.clerkOrgId).eq("clerkUserId", claims.subject),
      )
      .unique();
    return { emailOptOut: preference?.emailOptOut ?? false };
  },
});

export const setEmailPreference = mutation({
  args: { orgSlug: v.string(), emailOptOut: v.boolean() },
  handler: async (ctx, args) => {
    const { claims, org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const preference = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) =>
        q.eq("clerkOrgId", org.clerkOrgId).eq("clerkUserId", claims.subject),
      )
      .unique();
    if (preference)
      await ctx.db.patch(preference._id, { emailOptOut: args.emailOptOut });
    else
      await ctx.db.insert("notificationPreferences", {
        clerkOrgId: org.clerkOrgId,
        clerkUserId: claims.subject,
        emailOptOut: args.emailOptOut,
      });
    return { emailOptOut: args.emailOptOut };
  },
});
