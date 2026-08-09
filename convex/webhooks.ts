import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectMember } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { postWebhook } from "./lib/webhookDelivery";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max delivery attempts before marking failed. */
export const MAX_WEBHOOK_ATTEMPTS = 3;

/** Backoff seconds between retries: after attempt 1 → 60s, after attempt 2 → 300s. */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300] as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** URL must be https; http://localhost allowed for dev. */
export function validateWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && parsed.hostname === "localhost") {
    return true;
  }
  return false;
}

/** Generate a random signing secret. */
function generateSecret(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Webhook event firing (called from other modules' mutations)
// ---------------------------------------------------------------------------

/**
 * Queue a webhook delivery for a project's endpoint.
 * No-op when endpoint missing or inactive.
 * Called from specs.publish, specs.deprecateVersion, admin.setProjectVisibility.
 */
export async function fireWebhookEvent(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  event: string,
  data: unknown,
): Promise<void> {
  const endpoint = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (endpoint === null || !endpoint.active) return;

  const timestamp = Date.now();
  const payload = JSON.stringify({ event, data, timestamp });
  const deliveryId = await ctx.db.insert("webhookDeliveries", {
    endpointId: endpoint._id,
    event,
    status: "pending",
    attempts: 0,
    createdAt: timestamp,
    payload,
  });

  await ctx.scheduler.runAfter(0, internal.webhooks.deliverWebhook, {
    deliveryId,
  });
}

// ---------------------------------------------------------------------------
// Public API — endpoint CRUD
// ---------------------------------------------------------------------------

/**
 * Create or update the webhook endpoint for a project (one per project).
 * Secret auto-generated on create, preserved on update.
 */
export const upsertEndpoint = mutation({
  args: {
    projectId: v.id("projects"),
    url: v.string(),
    active: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Doc<"webhookEndpoints">> => {
    await requireProjectMember(ctx, args.projectId);

    const url = args.url.trim();
    if (!validateWebhookUrl(url)) {
      throw new Error("URL must be https (http://localhost allowed for dev)");
    }

    const existing = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();

    if (existing === null) {
      const id = await ctx.db.insert("webhookEndpoints", {
        projectId: args.projectId,
        url,
        secret: generateSecret(),
        active: args.active ?? true,
        createdAt: Date.now(),
      });
      const created = await ctx.db.get(id);
      if (created === null) throw new Error("Failed to create endpoint");
      return created;
    }

    await ctx.db.patch(existing._id, {
      url,
      active: args.active ?? existing.active,
    });
    const updated = await ctx.db.get(existing._id);
    if (updated === null) throw new Error("Failed to load endpoint");
    return updated;
  },
});

/** Fetch the webhook endpoint for a project (null if none). */
export const getEndpoint = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Doc<"webhookEndpoints"> | null> => {
    await requireProjectMember(ctx, args.projectId);
    return await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
  },
});

/** Delete the webhook endpoint for a project. */
export const deleteEndpoint = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    await requireProjectMember(ctx, args.projectId);
    const existing = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (existing === null) return { deleted: false };
    await ctx.db.delete(existing._id);
    return { deleted: true };
  },
});

/** Paginated delivery log for a project's endpoint, newest first. */
export const listDeliveries = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireProjectMember(ctx, args.projectId);
    const endpoint = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (endpoint === null) {
      return {
        page: [] as Doc<"webhookDeliveries">[],
        isDone: true,
        continueCursor: "",
      };
    }
    return await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpoint", (q) => q.eq("endpointId", endpoint._id))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ---------------------------------------------------------------------------
// Internal — delivery lifecycle
// ---------------------------------------------------------------------------

/** Load delivery + endpoint join for the action. */
export const getDeliveryForAction = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    url: string;
    secret: string;
    active: boolean;
    event: string;
    payload: string;
    attempts: number;
    status: Doc<"webhookDeliveries">["status"];
  } | null> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return null;
    const endpoint = await ctx.db.get(delivery.endpointId);
    if (endpoint === null) return null;
    return {
      url: endpoint.url,
      secret: endpoint.secret,
      active: endpoint.active,
      event: delivery.event,
      payload: delivery.payload,
      attempts: delivery.attempts,
      status: delivery.status,
    };
  },
});

/**
 * Record a delivery attempt result and manage retry/failure state machine.
 * On final failure, marks delivery failed + fires webhook_failed notification.
 */
export const recordDeliveryAttempt = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return;

    const nextAttempts = delivery.attempts + 1;

    if (args.ok) {
      await ctx.db.patch(args.deliveryId, {
        status: "ok",
        attempts: nextAttempts,
      });
      return;
    }

    if (args.retryable !== false && nextAttempts < MAX_WEBHOOK_ATTEMPTS) {
      await ctx.db.patch(args.deliveryId, {
        attempts: nextAttempts,
        lastError: args.error,
      });
      const backoffIndex = nextAttempts - 1;
      const backoffSec = WEBHOOK_BACKOFF_SECONDS[backoffIndex] ?? 300;
      await ctx.scheduler.runAfter(
        backoffSec * 1000,
        internal.webhooks.deliverWebhook,
        { deliveryId: args.deliveryId },
      );
      return;
    }

    // Final failure — mark failed + notify publisher org.
    await ctx.db.patch(args.deliveryId, {
      status: "failed",
      attempts: nextAttempts,
      lastError: args.error,
    });

    const endpoint = await ctx.db.get(delivery.endpointId);
    if (endpoint === null) return;
    const project = await ctx.db.get(endpoint.projectId);
    if (project === null) return;
    const org = await ctx.db.get(project.organizationId);
    if (org === null) return;

    await createNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "webhook_failed",
      title: "Webhook delivery failed",
      body: `Delivery of "${delivery.event}" failed after ${nextAttempts} attempt${nextAttempts === 1 ? "" : "s"}${args.error !== undefined ? `: ${args.error}` : ""}.`,
      refId: `webhook_failed:${args.deliveryId}`,
    });
  },
});

/**
 * Delivery action: load delivery + endpoint, POST webhook, record result.
 * Scheduled by fireWebhookEvent (initial) and recordDeliveryAttempt (retries).
 */
export const deliverWebhook = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args): Promise<void> => {
    const info = await ctx.runQuery(internal.webhooks.getDeliveryForAction, {
      deliveryId: args.deliveryId,
    });
    if (info === null) return;

    if (!info.active) {
      await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
        deliveryId: args.deliveryId,
        ok: false,
        error: "Endpoint inactive",
      });
      return;
    }

    const parsed = JSON.parse(info.payload) as {
      event: string;
      data: unknown;
      timestamp: number;
    };

    const result = await postWebhook({
      url: info.url,
      secret: info.secret,
      event: parsed.event,
      data: parsed.data,
      timestamp: parsed.timestamp,
      deliveryId: args.deliveryId,
      currentStatus: info.status,
    });

    if (result.skipped) return;

    await ctx.runMutation(internal.webhooks.recordDeliveryAttempt, {
      deliveryId: args.deliveryId,
      ok: result.ok,
      error: result.error,
      retryable: result.retryable,
    });
  },
});
