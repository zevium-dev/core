import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Notification kinds shared by all producers. */
export type NotificationKind =
  | "low_balance"
  | "spec_published"
  | "version_deprecated"
  | "webhook_failed"
  | "visibility_changed";

export type CreateNotificationArgs = {
  clerkOrgId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string;
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
    return { created: false, id: existing._id };
  }

  const id = await ctx.db.insert("notifications", {
    clerkOrgId: args.clerkOrgId,
    kind: args.kind,
    title: args.title,
    body: args.body,
    refId: args.refId,
    createdAt: Date.now(),
  });
  return { created: true, id };
}
