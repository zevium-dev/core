import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { components, internal } from "./_generated/api";
const emailLimiter = new RateLimiter(components.rateLimiter, {
  recipientPages: {
    kind: "token bucket",
    rate: 30,
    period: MINUTE,
    capacity: 2,
  },
});
import { isActive } from "./lib/identity";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  emailConfig,
  notificationMailer,
  notificationTemplate,
} from "./lib/notificationEmail";

const pageArgs = {
  notificationId: v.id("notifications"),
  revision: v.number(),
  offset: v.number(),
};
type PageArgs = {
  notificationId: Id<"notifications">;
  revision: number;
  offset: number;
};

async function pendingPage(ctx: QueryCtx, args: PageArgs) {
  const notification = await ctx.db.get(args.notificationId);
  if (
    !notification ||
    notification.emailRevision !== args.revision ||
    notification.emailOffset !== args.offset ||
    notification.emailState !== "pending"
  )
    return null;
  const org = await ctx.db.get(notification.organizationId);
  if (!org || !(await isActive(ctx, org))) return null;
  return { notification, org };
}

export const page = internalQuery({ args: pageArgs, handler: pendingPage });

/** Durable watchdog: action crashes/network errors retry, with a bounded budget. */
export const tick = internalMutation({
  args: pageArgs,
  handler: async (ctx, args): Promise<void> => {
    const current = await pendingPage(ctx, args);
    if (!current) {
      const notification = await ctx.db.get(args.notificationId);
      if (
        notification?.emailRevision === args.revision &&
        notification.emailOffset === args.offset &&
        notification.emailState === "pending"
      ) {
        await ctx.db.patch(args.notificationId, { emailState: "skipped" });
        console.info("Notification email skipped: organization inactive", {
          notificationId: args.notificationId,
        });
      }
      return;
    }
    if (!emailConfig()) {
      await ctx.db.patch(args.notificationId, { emailState: "skipped" });
      console.info("Notification email skipped: email configuration missing", {
        notificationId: args.notificationId,
      });
      return;
    }
    const admission = await emailLimiter.limit(ctx, "recipientPages");
    if (!admission.ok) {
      await ctx.scheduler.runAfter(
        Math.max(2000, admission.retryAfter),
        internal.notificationEmail.tick,
        args,
      );
      return;
    }
    const attempts = current.notification.emailAttempts ?? 0;
    if (attempts >= 5) {
      await ctx.db.patch(args.notificationId, { emailState: "failed" });
      console.warn("Notification email recipient lookup exhausted retries", {
        notificationId: args.notificationId,
      });
      return;
    }
    await ctx.db.patch(args.notificationId, { emailAttempts: attempts + 1 });
    await ctx.scheduler.runAfter(
      0,
      internal.notificationEmailAction.deliverPage,
      args,
    );
    await ctx.scheduler.runAfter(
      60_000 * 2 ** attempts,
      internal.notificationEmail.tick,
      args,
    );
  },
});

/** Component enqueue and our permanent receipt commit in the same transaction. */
export const enqueueRecipient = internalMutation({
  args: { ...pageArgs, clerkUserId: v.string(), email: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const current = await pendingPage(ctx, args);
    const config = emailConfig();
    if (!current || !config) return;
    const preference = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) =>
        q
          .eq("clerkOrgId", current.org.clerkOrgId)
          .eq("clerkUserId", args.clerkUserId),
      )
      .unique();
    if (preference?.emailOptOut) return;
    const existing = await ctx.db
      .query("notificationEmailDeliveries")
      .withIndex("by_notification_revision_user", (q) =>
        q
          .eq("notificationId", args.notificationId)
          .eq("revision", args.revision)
          .eq("clerkUserId", args.clerkUserId),
      )
      .unique();
    if (existing) return;
    const emailId = await notificationMailer().sendEmail(ctx, {
      from: config.from,
      to: args.email,
      ...notificationTemplate(
        current.notification,
        current.org.name,
        config.appOrigin,
      ),
      idempotencyKey: `notification:${args.notificationId}:${args.revision}:${args.clerkUserId}`,
    });
    await ctx.db.insert("notificationEmailDeliveries", {
      notificationId: args.notificationId,
      revision: args.revision,
      clerkUserId: args.clerkUserId,
      emailId,
    });
  },
});

export const completePage = internalMutation({
  args: { ...pageArgs, nextOffset: v.union(v.number(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    if (!(await pendingPage(ctx, args))) return;
    if (!emailConfig()) {
      await ctx.db.patch(args.notificationId, { emailState: "skipped" });
      console.info("Notification email skipped: email configuration missing", {
        notificationId: args.notificationId,
      });
      return;
    }
    if (args.nextOffset === null) {
      await ctx.db.patch(args.notificationId, { emailState: "queued" });
      return;
    }
    await ctx.db.patch(args.notificationId, {
      emailOffset: args.nextOffset,
      emailAttempts: 0,
    });
    await ctx.scheduler.runAfter(2000, internal.notificationEmail.tick, {
      notificationId: args.notificationId,
      revision: args.revision,
      offset: args.nextOffset,
    });
  },
});
