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
  | "transfer_sent";

export type CreateNotificationArgs = {
  clerkOrgId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refId: string;
  publisherHandle?: string;
  projectSlug?: string;
};

export type CreateNotificationResult = {
  created: boolean;
  id: Id<"notifications"> | null;
};

const LEGACY_UNREAD_COUNT_CAP = 100;

/** Keep unread UI O(1); legacy rows use one bounded bootstrap read. */
export async function changeUnreadNotificationCount(
  ctx: MutationCtx,
  clerkOrgId: string,
  delta: number,
): Promise<void> {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  if (organization === null) return;
  if (organization.unreadNotificationCountCapped === true) return;
  if (organization.unreadNotificationCount !== undefined) {
    await ctx.db.patch(organization._id, {
      unreadNotificationCount: Math.max(
        0,
        organization.unreadNotificationCount + delta,
      ),
      unreadNotificationCountCapped: false,
    });
    return;
  }
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_org_read", (q) =>
      q.eq("clerkOrgId", clerkOrgId).eq("readAt", undefined),
    )
    .take(LEGACY_UNREAD_COUNT_CAP);
  await ctx.db.patch(organization._id, {
    unreadNotificationCount: unread.length,
    unreadNotificationCountCapped: unread.length === LEGACY_UNREAD_COUNT_CAP,
  });
}

export async function clearUnreadNotificationCount(
  ctx: MutationCtx,
  clerkOrgId: string,
): Promise<void> {
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
  if (organization === null) return;
  await ctx.db.patch(organization._id, {
    unreadNotificationCount: 0,
    unreadNotificationCountCapped: false,
  });
}

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
    if (existing.clerkOrgId !== args.clerkOrgId) {
      throw new Error("Notification reference belongs to another organization");
    }
    return { created: false, id: existing._id };
  }

  const id = await ctx.db.insert("notifications", {
    clerkOrgId: args.clerkOrgId,
    kind: args.kind,
    title: args.title,
    body: args.body,
    refId: args.refId,
    publisherHandle: args.publisherHandle,
    projectSlug: args.projectSlug,
    createdAt: Date.now(),
  });
  await changeUnreadNotificationCount(ctx, args.clerkOrgId, 1);
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
  if (existing.clerkOrgId !== args.clerkOrgId) {
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
  const wasRead = existing.readAt !== undefined;
  await ctx.db.patch(existing._id, {
    kind: args.kind,
    title: args.title,
    body: args.body,
    publisherHandle: args.publisherHandle,
    projectSlug: args.projectSlug,
    readAt: undefined,
    createdAt: Date.now(),
  });
  if (wasRead) {
    await changeUnreadNotificationCount(ctx, args.clerkOrgId, 1);
  }
  return { created: false, id: existing._id };
}

export type ProjectRetirementConsumerNoticeArgs = {
  consumerClerkOrgId: string;
  projectId: Id<"projects">;
  projectName: string;
  projectSlug: string;
  publisherName: string;
  publisherHandle?: string;
  sunsetAt: number;
  message?: string;
  event: "scheduled" | "canceled";
};

/** One canonical retirement notice per project and consumer organization. */
export async function upsertProjectRetirementConsumerNotice(
  ctx: MutationCtx,
  args: ProjectRetirementConsumerNoticeArgs,
): Promise<CreateNotificationResult> {
  return await upsertNotification(ctx, {
    clerkOrgId: args.consumerClerkOrgId,
    kind: "project_retirement",
    title:
      args.event === "scheduled"
        ? `${args.projectName} retirement scheduled`
        : `${args.projectName} retirement canceled`,
    body:
      args.event === "scheduled"
        ? `${args.publisherName}'s ${args.projectName} API will sunset ${new Date(args.sunsetAt).toISOString()}. ${args.message ?? "Migrate before the cutoff."}`
        : `${args.publisherName}'s ${args.projectName} API retirement scheduled for ${new Date(args.sunsetAt).toISOString()} was canceled.`,
    refId: `project_retirement:${args.projectId}:consumer:${args.consumerClerkOrgId}`,
    publisherHandle: args.publisherHandle,
    projectSlug: args.projectSlug,
  });
}
