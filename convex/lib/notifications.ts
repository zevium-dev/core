import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Notification kinds shared by all producers. */
export type NotificationKind =
  | "low_balance"
  | "spec_published"
  | "version_deprecated"
  | "project_retirement"
  | "webhook_failed"
  | "visibility_changed"
  | "transfer_failed"
  | "transfer_sent"
  | "quality_suspended"
  | "quality_restored";

export type CreateNotificationArgs = {
  organizationId: Id<"organizations">;
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string;
  publisherHandle?: string;
  projectSlug?: string;
  email?: boolean;
};

export type CreateNotificationResult = {
  created: boolean;
  id: Id<"notifications"> | null;
};

/**
 * Idempotent notification insert. If a notification with the same refId
 * already exists, returns { created: false } without writing.
 * Safe to call from any mutation context.
 */
export async function createNotification(
  ctx: MutationCtx,
  args: CreateNotificationArgs,
): Promise<CreateNotificationResult> {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing !== null) {
    if (existing.organizationId !== args.organizationId) {
      throw new Error("Notification reference belongs to another organization");
    }
    return { created: false, id: existing._id };
  }

  const id = await ctx.db.insert("notifications", {
    adminOnly: args.kind === "webhook_failed" ? true : undefined,
    organizationId: args.organizationId,
    kind: args.kind,
    title: args.title,
    body: args.body,
    refId: args.refId,
    publisherHandle: args.publisherHandle,
    projectSlug: args.projectSlug,
    createdAt: Date.now(),
  });
  if (args.email !== false) await scheduleNotificationEmail(ctx, id, 1);
  return { created: true, id };
}

/**
 * Canonical lifecycle notice. Identical retries do nothing; changed schedule
 * state replaces the existing row, marks it unread, and moves it to the top.
 */
export async function upsertNotification(
  ctx: MutationCtx,
  args: CreateNotificationArgs,
): Promise<CreateNotificationResult> {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_ref", (q) => q.eq("refId", args.refId))
    .unique();
  if (existing === null) return await createNotification(ctx, args);
  if (existing.organizationId !== args.organizationId) {
    throw new Error("Notification reference belongs to another organization");
  }
  if (
    existing.kind === args.kind &&
    existing.title === args.title &&
    existing.body === args.body &&
    existing.publisherHandle === args.publisherHandle &&
    existing.projectSlug === args.projectSlug
  ) {
    return { created: false, id: existing._id };
  }
  await ctx.db.patch(existing._id, {
    adminOnly: args.kind === "webhook_failed" ? true : undefined,
    kind: args.kind,
    title: args.title,
    body: args.body,
    publisherHandle: args.publisherHandle,
    projectSlug: args.projectSlug,
    readAt: undefined,
    createdAt: Date.now(),
  });
  if (args.email !== false)
    await scheduleNotificationEmail(
      ctx,
      existing._id,
      (existing.emailRevision ?? 0) + 1,
    );
  return { created: false, id: existing._id };
}

/** Only schedule local work here. Provider failures cannot roll back the inbox. */
async function scheduleNotificationEmail(
  ctx: MutationCtx,
  notificationId: Id<"notifications">,
  revision: number,
): Promise<void> {
  const configured = Boolean(process.env.RESEND_API_KEY?.trim());
  await ctx.db.patch(notificationId, {
    emailRevision: revision,
    emailOffset: 0,
    emailAttempts: 0,
    emailState: configured ? "pending" : "skipped",
  });
  if (!configured) {
    console.info("Notification email skipped: RESEND_API_KEY unset", {
      notificationId,
    });
    return;
  }
  await ctx.scheduler.runAfter(0, internal.notificationEmail.tick, {
    notificationId,
    revision,
    offset: 0,
  });
}
