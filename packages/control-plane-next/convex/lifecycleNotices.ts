import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { components, internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
const limiter = new RateLimiter(components.rateLimiter, {
  lifecycle: { kind: "token bucket", rate: 6, period: HOUR, capacity: 6 },
});
export async function limitLifecycle(
  ctx: MutationCtx,
  project: Doc<"projects">,
) {
  if (!(await limiter.limit(ctx, "lifecycle", { key: project._id })).ok)
    throw new ConvexError("Lifecycle update limit reached. Try again later.");
}
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { createNotification, upsertNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import { isActive } from "./lib/identity";
export async function publicationNotice(
  ctx: MutationCtx,
  project: Doc<"projects">,
  version: Doc<"specVersions">,
) {
  await createNotification(ctx, {
    organizationId: project.organizationId,
    kind: "spec_published",
    title: `${project.name} published`,
    body: `Version ${version.version} is published.`,
    refId: `spec_published:${version._id}`,
  });
  await fireWebhookEvent(ctx, project._id, "spec.published", {
    projectId: project._id,
    version: version.version,
  });
}
export async function retirementNotice(
  ctx: MutationCtx,
  before: Doc<"projects">,
  after: Doc<"projects">,
) {
  if (before.retirement?.revision === after.retirement?.revision) return;
  if (after.retirement?.state !== "retired") await limitLifecycle(ctx, after);
  const email =
    !before.retirement ||
    !after.retirement ||
    before.retirement.state !== after.retirement.state;
  const canceled = !after.retirement,
    body = canceled
      ? "Scheduled retirement was canceled."
      : after.retirement?.state === "retired"
        ? `${after.name} has retired. ${after.retirement.message}`
        : `${after.name} retires on ${new Date(after.retirement!.sunsetAt).toISOString()}. ${after.retirement!.message}`;
  await upsertNotification(ctx, {
    organizationId: after.organizationId,
    kind: "project_retirement",
    title: `${after.name} retirement ${canceled ? "canceled" : after.retirement?.state === "retired" ? "completed" : "scheduled"}`,
    body,
    refId: `retirement:${after._id}`,
    email,
  });
  await fireWebhookEvent(
    ctx,
    after._id,
    canceled ? "project.deprecation_canceled" : "project.deprecated",
    { projectId: after._id, sunsetAt: after.retirement?.sunsetAt ?? null },
  );
  await ctx.scheduler.runAfter(0, internal.lifecycleNotices.consumers, {
    projectId: after._id,
    revision: after.retirement?.revision ?? 0,
    versionId: null,
    cursor: null,
    body,
    email,
  });
}
export const consumers = internalMutation({
  args: {
    projectId: v.id("projects"),
    revision: v.number(),
    versionId: v.union(v.id("specVersions"), v.null()),
    cursor: v.union(v.string(), v.null()),
    body: v.string(),
    email: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const p = await ctx.db.get(args.projectId),
      publisher = p && (await ctx.db.get(p.organizationId));
    if (!p || !publisher || !(await isActive(ctx, publisher))) return;
    const version = args.versionId ? await ctx.db.get(args.versionId) : null;
    if (
      args.versionId
        ? !version?.deprecatedAt ||
          version.projectId !== p._id ||
          version.noticeRevision !== args.revision
        : (p.retirement?.revision ?? 0) !== args.revision
    )
      return;
    const rows = await ctx.db
      .query("usageRollups")
      .withIndex("by_project_consumers", (q) =>
        q.eq("kind", "lifetime_consumer_project").eq("projectId", p._id),
      )
      .paginate({ cursor: args.cursor, numItems: 25, maximumRowsRead: 26 });
    for (const r of rows.page)
      if (r.kind === "lifetime_consumer_project") {
        const org = await ctx.db.get(r.consumerOrganizationId);
        if (!org || !(await isActive(ctx, org))) continue;
        await upsertNotification(ctx, {
          organizationId: org._id,
          kind: version ? "version_deprecated" : "project_retirement",
          title: version
            ? `${p.name} version ${version.version} deprecated`
            : `${p.name} retirement update`,
          body: args.body,
          email: args.email,
          refId: `consumer_notice:${args.versionId ?? p._id}:${org._id}`,
          publisherHandle: publisher.publicHandle,
          projectSlug: p.slug,
        });
      }
    if (!rows.isDone)
      await ctx.scheduler.runAfter(5000, internal.lifecycleNotices.consumers, {
        ...args,
        cursor: rows.continueCursor,
      });
  },
});
