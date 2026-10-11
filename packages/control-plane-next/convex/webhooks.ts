import { paginationOptsValidator } from "convex/server";
import { v, ConvexError } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectAdmin } from "./lib/auth";
import { isActive } from "./lib/identity";
import {
  encryptSecret,
  decryptSecret,
  webhookBinding,
} from "./lib/credentialCrypto";
import { validateWebhookUrl } from "./lib/webhookDelivery";
import { createNotification } from "./lib/notifications";
export { validateWebhookUrl } from "./lib/webhookDelivery";
const metadata = (w: NonNullable<Doc<"projects">["webhook"]>) => ({
  url: w.url,
  active: w.active,
  secretVersion: w.secretVersion,
  createdAt: w.createdAt,
});
const status = (state: Doc<"webhookDeliveries">["state"]) =>
  state === "complete"
    ? ("ok" as const)
    : state === "needs_review"
      ? ("failed" as const)
      : state === "processing"
        ? ("delivering" as const)
        : ("pending" as const);
export async function fireWebhookEvent(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  event: string,
  data: unknown,
) {
  const p = await ctx.db.get(projectId),
    org = p && (await ctx.db.get(p.organizationId));
  if (
    !p?.webhook?.active ||
    p.retirement?.state === "retired" ||
    !org ||
    !(await isActive(ctx, org))
  )
    return;
  const deliveryId = crypto.randomUUID();
  const id = await ctx.db.insert("webhookDeliveries", {
    projectId,
    deliveryId,
    event,
    payload: JSON.stringify({ event, data, timestamp: Date.now() }),
    secretVersion: p.webhook.secretVersion,
    state: "pending",
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.webhookDeliveryAction.deliverWebhook,
    { deliveryId: id },
  );
}
export const getEndpoint = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    return project.webhook ? metadata(project.webhook) : null;
  },
});
export const upsertEndpoint = mutation({
  args: {
    projectId: v.id("projects"),
    url: v.string(),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId),
      url = args.url.trim();
    if (url.length > 2048 || !validateWebhookUrl(url))
      throw new ConvexError("URL must be a public HTTPS endpoint");
    const secretVersion = project.revision + 1;
    const webhook = project.webhook
      ? {
          ...project.webhook,
          url,
          active: args.active ?? project.webhook.active,
        }
      : {
          url,
          active: args.active ?? true,
          current: await encryptSecret(
            `${crypto.randomUUID()}.${crypto.randomUUID()}`,
            webhookBinding(project._id, secretVersion),
          ),
          secretVersion,
          createdAt: Date.now(),
        };
    await ctx.db.patch(project._id, {
      webhook,
      revision: project.revision + 1,
    });
    return metadata(webhook);
  },
});
export const revealSecret = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId),
      w = project.webhook;
    if (!w || w.revealedAt !== undefined) return null;
    const secret = await decryptSecret(
      w.current,
      webhookBinding(project._id, w.secretVersion),
    );
    await ctx.db.patch(project._id, {
      webhook: { ...w, revealedAt: Date.now() },
    });
    return { secret };
  },
});
export const rotateSecret = mutation({
  args: { projectId: v.id("projects"), graceSeconds: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId),
      w = project.webhook;
    if (!w) throw new ConvexError("Webhook endpoint not found");
    const grace = args.graceSeconds ?? 3600;
    if (!Number.isSafeInteger(grace) || grace < 0 || grace > 86400)
      throw new ConvexError("Secret grace must be between 0 and 86400 seconds");
    const secret = `${crypto.randomUUID()}.${crypto.randomUUID()}`,
      secretVersion = Math.max(project.revision, w.secretVersion) + 1,
      previousValidUntil = Date.now() + grace * 1000;
    await ctx.db.patch(project._id, {
      revision: secretVersion,
      webhook: {
        ...w,
        current: await encryptSecret(
          secret,
          webhookBinding(project._id, secretVersion),
        ),
        secretVersion,
        revealedAt: Date.now(),
        previous: w.current,
        previousVersion: w.secretVersion,
        previousValidUntil,
      },
    });
    return { secret, secretVersion, previousValidUntil };
  },
});
export const deleteEndpoint = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    await ctx.db.patch(project._id, {
      webhook: undefined,
      revision: project.revision + 1,
    });
    return { deleted: project._id };
  },
});
export const listDeliveries = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireProjectAdmin(ctx, args.projectId);
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_project_time", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
        maximumRowsRead: 51,
      });
    return {
      ...rows,
      page: rows.page.map((d) => ({
        id: d.deliveryId,
        event: d.event,
        status: status(d.state),
        attempts: d.attempts,
        lastError: d.lastErrorCode,
        createdAt: d.createdAt,
        secretVersion: d.secretVersion,
      })),
    };
  },
});
export const claimDelivery = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    leaseToken: v.string(),
    expectedExpiredLeaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId),
      now = Date.now();
    if (
      !d ||
      d.state === "complete" ||
      d.state === "needs_review" ||
      (d.state === "processing" && (d.leaseUntil ?? 0) > now) ||
      (d.nextAttemptAt ?? 0) > now
    )
      return null;
    if (
      args.expectedExpiredLeaseToken !== undefined &&
      (d.state !== "processing" ||
        d.leaseToken !== args.expectedExpiredLeaseToken)
    )
      return null;
    const p = await ctx.db.get(d.projectId),
      w = p?.webhook,
      org = p && (await ctx.db.get(p.organizationId));
    const encryptedSecret =
      w &&
      (d.secretVersion === w.secretVersion
        ? w.current
        : d.secretVersion === w.previousVersion &&
            (w.previousValidUntil ?? 0) > now
          ? w.previous
          : undefined);
    if (
      !p ||
      !w ||
      !encryptedSecret ||
      p.retirement?.state === "retired" ||
      !org ||
      !(await isActive(ctx, org)) ||
      d.attempts >= 3
    ) {
      await ctx.db.patch(d._id, {
        state: "needs_review",
        lastErrorCode: "Endpoint or signing generation unavailable",
        leaseToken: undefined,
        leaseUntil: undefined,
      });
      return null;
    }
    await ctx.db.patch(d._id, {
      state: "processing",
      attempts: d.attempts + 1,
      leaseToken: args.leaseToken,
      leaseUntil: now + 30000,
      nextAttemptAt: undefined,
    });
    await ctx.scheduler.runAfter(
      30000,
      internal.webhookDeliveryAction.deliverWebhook,
      { deliveryId: d._id, recoveryLeaseToken: args.leaseToken },
    );
    return {
      url: w.url,
      deliveryId: d.deliveryId,
      encryptedSecret,
      secretVersion: d.secretVersion,
      projectId: p._id,
      active: w.active && w.retiringAt === undefined,
      payload: d.payload,
    };
  },
});
export const recordDeliveryAttempt = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deliveryId);
    if (!d || d.state !== "processing" || d.leaseToken !== args.leaseToken)
      return;
    const retry = !args.ok && args.retryable !== false && d.attempts < 3,
      nextAttemptAt = retry
        ? Date.now() + (d.attempts === 1 ? 60000 : 300000)
        : undefined;
    await ctx.db.patch(d._id, {
      state: args.ok ? "complete" : retry ? "retry" : "needs_review",
      leaseToken: undefined,
      leaseUntil: undefined,
      nextAttemptAt,
      lastErrorCode: args.ok ? undefined : "Delivery failed",
    });
    if (retry)
      await ctx.scheduler.runAt(
        nextAttemptAt!,
        internal.webhookDeliveryAction.deliverWebhook,
        { deliveryId: d._id },
      );
    else if (!args.ok) {
      const p = await ctx.db.get(d.projectId);
      if (p)
        await createNotification(ctx, {
          organizationId: p.organizationId,
          kind: "webhook_failed",
          title: "Webhook delivery failed",
          body: `Delivery of ${d.event} failed after ${d.attempts} attempts.`,
          refId: `webhook_failed:${d._id}`,
        });
    }
  },
});
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const state of ["pending", "retry"] as const) {
      const rows = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_due", (q) =>
          q.eq("state", state).lte("nextAttemptAt", Date.now()),
        )
        .take(25);
      for (const d of rows)
        await ctx.scheduler.runAfter(
          0,
          internal.webhookDeliveryAction.deliverWebhook,
          { deliveryId: d._id },
        );
    }
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_lease", (q) =>
        q.eq("state", "processing").lte("leaseUntil", Date.now()),
      )
      .take(25);
    for (const d of rows)
      await ctx.scheduler.runAfter(
        0,
        internal.webhookDeliveryAction.deliverWebhook,
        { deliveryId: d._id, recoveryLeaseToken: d.leaseToken },
      );
  },
});
