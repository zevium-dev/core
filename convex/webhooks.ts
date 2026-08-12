import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectAdmin, requireProjectMember } from "./lib/auth";
import {
  decryptSecret,
  encryptSecret,
  migrateStoredSecret,
  requireEncryptedSecret,
  webhookBinding,
  type EncryptedSecret,
} from "./lib/credentialCrypto";
import { createNotification } from "./lib/notifications";
import { validateWebhookUrl } from "./lib/webhookDelivery";

export { validateWebhookUrl } from "./lib/webhookDelivery";

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

/** Generate a random signing secret. */
function generateSecret(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

export type WebhookEndpointMetadata = {
  id: Id<"webhookEndpoints">;
  url: string;
  active: boolean;
  createdAt: number;
};

function endpointMetadata(
  endpoint: Doc<"webhookEndpoints">,
): WebhookEndpointMetadata {
  return {
    id: endpoint._id,
    url: endpoint.url,
    active: endpoint.active,
    createdAt: endpoint.createdAt,
  };
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

  await ctx.scheduler.runAfter(
    0,
    internal.webhookDeliveryAction.deliverWebhook,
    {
      deliveryId,
    },
  );
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
  handler: async (ctx, args): Promise<WebhookEndpointMetadata> => {
    await requireProjectAdmin(ctx, args.projectId);

    const url = args.url.trim();
    if (!validateWebhookUrl(url)) {
      throw new Error("URL must be a public https endpoint");
    }

    const existing = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();

    if (existing === null) {
      let encryptedSecret: EncryptedSecret;
      try {
        encryptedSecret = await encryptSecret(
          generateSecret(),
          webhookBinding(args.projectId),
        );
      } catch {
        throw new Error("Signing secret could not be created");
      }
      const id = await ctx.db.insert("webhookEndpoints", {
        projectId: args.projectId,
        url,
        ...encryptedSecret,
        active: args.active ?? true,
        createdAt: Date.now(),
      });
      const created = await ctx.db.get(id);
      if (created === null) throw new Error("Failed to create endpoint");
      return endpointMetadata(created);
    }

    await ctx.db.patch(existing._id, {
      url,
      active: args.active ?? existing.active,
    });
    const updated = await ctx.db.get(existing._id);
    if (updated === null) throw new Error("Failed to load endpoint");
    return endpointMetadata(updated);
  },
});

/** Fetch non-secret webhook endpoint metadata for an admin. */
export const getEndpoint = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<WebhookEndpointMetadata | null> => {
    await requireProjectAdmin(ctx, args.projectId);
    const endpoint = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    return endpoint === null ? null : endpointMetadata(endpoint);
  },
});

/** Explicit, ephemeral signing-secret reveal. Never returned from CRUD reads. */
export const revealSecret = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ secret: string } | null> => {
    await requireProjectAdmin(ctx, args.projectId);
    const endpoint = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (endpoint === null) return null;

    try {
      return {
        secret: await decryptSecret(
          requireEncryptedSecret(endpoint),
          webhookBinding(args.projectId),
        ),
      };
    } catch {
      throw new Error("Signing secret is unavailable");
    }
  },
});

/** Delete the webhook endpoint for a project. */
export const deleteEndpoint = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    await requireProjectAdmin(ctx, args.projectId);
    const existing = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (existing === null) return { deleted: false };
    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpoint", (q) => q.eq("endpointId", existing._id))
      .collect();
    // Delete endpoint in the same transaction as its queue. Scheduled actions
    // then observe no endpoint and cannot deliver with a retired secret.
    for (const delivery of deliveries) await ctx.db.delete(delivery._id);
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
    encryptedSecret: {
      ciphertext?: string;
      iv?: string;
      keyVersion?: string;
      sealedCiphertext?: string;
      sealedIv?: string;
      sealedKeyVersion?: string;
      sealedVersion?: string;
    };
    projectId: Id<"projects">;
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
      encryptedSecret: {
        ciphertext: endpoint.ciphertext,
        iv: endpoint.iv,
        keyVersion: endpoint.keyVersion,
        sealedCiphertext: endpoint.sealedCiphertext,
        sealedIv: endpoint.sealedIv,
        sealedKeyVersion: endpoint.sealedKeyVersion,
        sealedVersion: endpoint.sealedVersion,
      },
      projectId: endpoint.projectId,
      active: endpoint.active,
      event: delivery.event,
      payload: delivery.payload,
      attempts: delivery.attempts,
      status: delivery.status,
    };
  },
});

export type WebhookSecretMigrationPage = {
  scanned: number;
  current: number;
  old: number;
  broken: number;
  corrupt: number;
  plaintext: number;
  recovered: number;
  rewrapped: number;
  scrubbed: number;
  continueCursor: string;
  isDone: boolean;
};

/** Cursor-bounded dual-envelope migration. Repeat until isDone, then audit again. */
export const migrateLegacyPlaintext = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<WebhookSecretMigrationPage> => {
    const requested = args.numItems ?? 50;
    const numItems = Math.max(1, Math.min(100, Math.floor(requested)));
    const result = await ctx.db.query("webhookEndpoints").paginate({
      cursor: args.cursor ?? null,
      numItems,
    });
    const counts = {
      scanned: result.page.length,
      current: 0,
      old: 0,
      broken: 0,
      corrupt: 0,
      plaintext: 0,
      recovered: 0,
      rewrapped: 0,
      scrubbed: 0,
    };

    for (const row of result.page) {
      const migration = await migrateStoredSecret(
        row,
        webhookBinding(row.projectId),
      );
      if (migration.plaintext) counts.plaintext += 1;
      if (migration.old) counts.old += 1;
      if (migration.corrupt) counts.corrupt += 1;
      if (migration.broken) counts.broken += 1;
      else counts.current += 1;
      if (migration.recovered) counts.recovered += 1;
      if (migration.rewrapped) counts.rewrapped += 1;
      if (migration.scrubbed) counts.scrubbed += 1;
      if (migration.patch) await ctx.db.patch(row._id, migration.patch);
    }

    return {
      ...counts,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
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
    // Duplicate actions can race after both read `pending`. Convex retries this
    // mutation on OCC, so re-check makes result/schedule/notification exact-once.
    if (delivery.status === "ok" || delivery.status === "failed") return;

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
        internal.webhookDeliveryAction.deliverWebhook,
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
