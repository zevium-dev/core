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
import { requireProjectAdmin, requireProjectMember } from "./lib/auth";
import {
  decryptSecret,
  encryptSecret,
  migrateStoredSecret,
  requireEncryptedSecret,
  webhookBinding,
  type EncryptedSecret,
  type StoredEncryptedSecret,
} from "./lib/credentialCrypto";
import { createNotification } from "./lib/notifications";
import { validateWebhookUrl } from "./lib/webhookDelivery";
import { beginWebhookRetirement } from "./retirementJobs";
import { publicReference } from "./lib/publicIds";
import {
  bumpSecurityRolloutGeneration,
  requireCompletedSecurityAudit,
} from "./securityRollout";

export { validateWebhookUrl } from "./lib/webhookDelivery";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max delivery attempts before marking failed. */
export const MAX_WEBHOOK_ATTEMPTS = 3;

/** Backoff seconds between retries: after attempt 1 → 60s, after attempt 2 → 300s. */
export const WEBHOOK_BACKOFF_SECONDS = [60, 300] as const;
export const DEFAULT_WEBHOOK_SECRET_GRACE_SECONDS = 60 * 60;
export const MAX_WEBHOOK_SECRET_GRACE_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Generate a random signing secret. */
function generateSecret(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

export type WebhookEndpointMetadata = {
  url: string;
  active: boolean;
  secretVersion: number;
  createdAt: number;
};

function endpointMetadata(
  endpoint: Doc<"webhookEndpoints">,
): WebhookEndpointMetadata {
  return {
    url: endpoint.url,
    active: endpoint.active,
    secretVersion: endpoint.secretVersion ?? 1,
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
  const secretVersion = endpoint.secretVersion ?? 1;
  const deliveryId = await ctx.db.insert("webhookDeliveries", {
    endpointId: endpoint._id,
    secretVersion,
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
        secretVersion: 1,
        active: args.active ?? true,
        createdAt: Date.now(),
      });
      const created = await ctx.db.get(id);
      if (created === null) throw new Error("Failed to create endpoint");
      await bumpSecurityRolloutGeneration(ctx);
      return endpointMetadata(created);
    }
    if (existing.retiringAt !== undefined) {
      throw new Error("Webhook endpoint is being deleted");
    }

    await ctx.db.patch(existing._id, {
      url,
      active: args.active ?? existing.active,
    });
    await bumpSecurityRolloutGeneration(ctx);
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
    return endpoint === null || endpoint.retiringAt !== undefined
      ? null
      : endpointMetadata(endpoint);
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
    if (endpoint === null || endpoint.retiringAt !== undefined) return null;
    if (endpoint.secretRevealedAt !== undefined) return null;

    try {
      const secret = await decryptSecret(
        requireEncryptedSecret(endpoint),
        webhookBinding(args.projectId, endpoint.secretVersion ?? 1),
      );
      await ctx.db.patch(endpoint._id, { secretRevealedAt: Date.now() });
      await bumpSecurityRolloutGeneration(ctx);
      return {
        secret,
      };
    } catch {
      throw new Error("Signing secret is unavailable");
    }
  },
});

/** Rotate signing material. Returned cleartext is the sole reveal for this version. */
export const rotateSecret = mutation({
  args: {
    projectId: v.id("projects"),
    graceSeconds: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    secret: string;
    secretVersion: number;
    previousValidUntil: number;
  }> => {
    await requireProjectAdmin(ctx, args.projectId);
    const graceSeconds =
      args.graceSeconds ?? DEFAULT_WEBHOOK_SECRET_GRACE_SECONDS;
    if (
      !Number.isSafeInteger(graceSeconds) ||
      graceSeconds < 0 ||
      graceSeconds > MAX_WEBHOOK_SECRET_GRACE_SECONDS
    ) {
      throw new Error("Webhook secret grace must be 0 to 86400 seconds");
    }
    const endpoint = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (endpoint === null || endpoint.retiringAt !== undefined) {
      throw new Error("Webhook endpoint not found");
    }
    if ((endpoint.previousValidUntil ?? 0) > Date.now()) {
      throw new Error("Previous webhook secret grace period is still active");
    }
    const currentVersion = endpoint.secretVersion ?? 1;
    try {
      await decryptSecret(
        requireEncryptedSecret(endpoint),
        webhookBinding(args.projectId, currentVersion),
      );
    } catch {
      throw new Error("Signing secret is unavailable");
    }

    const secretVersion = currentVersion + 1;
    const secret = generateSecret();
    let encrypted: EncryptedSecret;
    try {
      encrypted = await encryptSecret(
        secret,
        webhookBinding(args.projectId, secretVersion),
      );
    } catch {
      throw new Error("Signing secret could not be rotated");
    }
    const now = Date.now();
    const previousValidUntil = now + graceSeconds * 1000;
    await ctx.db.patch(endpoint._id, {
      ...encrypted,
      secret: undefined,
      secretVersion,
      // Rotation response is the one-time reveal.
      secretRevealedAt: now,
      previousCiphertext: endpoint.ciphertext,
      previousIv: endpoint.iv,
      previousKeyVersion: endpoint.keyVersion,
      previousSealedCiphertext: endpoint.sealedCiphertext,
      previousSealedIv: endpoint.sealedIv,
      previousSealedKeyVersion: endpoint.sealedKeyVersion,
      previousSealedVersion:
        endpoint.sealedVersion === "v2" ? "v2" : undefined,
      previousSecretVersion: currentVersion,
      previousValidUntil,
    });
    await bumpSecurityRolloutGeneration(ctx);
    return { secret, secretVersion, previousValidUntil };
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
    await beginWebhookRetirement(ctx, existing);
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
        page: [] as Array<{
          id: string;
          event: string;
          status: Doc<"webhookDeliveries">["status"];
          attempts: number;
          lastError?: string;
          createdAt: number;
          secretVersion: number;
        }>,
        isDone: true,
        continueCursor: "",
      };
    }
    const result = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpoint", (q) => q.eq("endpointId", endpoint._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (delivery) => ({
          id: await publicReference(
            "webhook-delivery",
            String(delivery._id),
          ),
          event: delivery.event,
          status: delivery.status,
          attempts: delivery.attempts,
          lastError: delivery.lastError,
          createdAt: delivery.createdAt,
          secretVersion: delivery.secretVersion ?? 1,
        })),
      ),
    };
  },
});

// ---------------------------------------------------------------------------
// Internal — delivery lifecycle
// ---------------------------------------------------------------------------

const WEBHOOK_DELIVERY_LEASE_MS = 30_000;

function currentSecretEnvelope(
  endpoint: Doc<"webhookEndpoints">,
): StoredEncryptedSecret {
  return {
    ciphertext: endpoint.ciphertext,
    iv: endpoint.iv,
    keyVersion: endpoint.keyVersion,
    sealedCiphertext: endpoint.sealedCiphertext,
    sealedIv: endpoint.sealedIv,
    sealedKeyVersion: endpoint.sealedKeyVersion,
    sealedVersion: endpoint.sealedVersion,
    secret: endpoint.secret,
  };
}

function previousSecretEnvelope(
  endpoint: Doc<"webhookEndpoints">,
): StoredEncryptedSecret {
  return {
    ciphertext: endpoint.previousCiphertext,
    iv: endpoint.previousIv,
    keyVersion: endpoint.previousKeyVersion,
    sealedCiphertext: endpoint.previousSealedCiphertext,
    sealedIv: endpoint.previousSealedIv,
    sealedKeyVersion: endpoint.previousSealedKeyVersion,
    sealedVersion: endpoint.previousSealedVersion,
  };
}

/** Transactional claim prevents concurrent scheduled actions from double-POSTing. */
export const claimDelivery = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    leaseToken: v.string(),
    expectedExpiredLeaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.leaseToken.length < 16 || args.leaseToken.length > 128) {
      throw new Error("Webhook delivery lease is invalid");
    }
    const delivery = await ctx.db.get(args.deliveryId);
    if (
      delivery === null ||
      delivery.status === "ok" ||
      delivery.status === "failed"
    ) {
      return null;
    }
    const now = Date.now();
    if (
      args.expectedExpiredLeaseToken !== undefined &&
      (delivery.status !== "delivering" ||
        delivery.leaseToken !== args.expectedExpiredLeaseToken ||
        (delivery.leaseUntil ?? 0) > now)
    ) {
      return null;
    }
    if (delivery.status === "delivering" && (delivery.leaseUntil ?? 0) > now) {
      return null;
    }
    const endpoint = await ctx.db.get(delivery.endpointId);
    if (endpoint === null) {
      await ctx.db.patch(delivery._id, {
        status: "failed",
        attempts: delivery.attempts + 1,
        lastError: "Endpoint retired",
        leaseToken: undefined,
        leaseUntil: undefined,
      });
      return null;
    }
    const secretVersion = delivery.secretVersion ?? 1;
    const currentVersion = endpoint.secretVersion ?? 1;
    let encryptedSecret: StoredEncryptedSecret;
    if (secretVersion === currentVersion) {
      encryptedSecret = currentSecretEnvelope(endpoint);
    } else if (
      secretVersion === endpoint.previousSecretVersion &&
      (endpoint.previousValidUntil ?? 0) > now
    ) {
      encryptedSecret = previousSecretEnvelope(endpoint);
    } else {
      await ctx.db.patch(delivery._id, {
        status: "failed",
        attempts: delivery.attempts + 1,
        lastError: "Signing secret generation expired",
        leaseToken: undefined,
        leaseUntil: undefined,
      });
      return null;
    }
    const leaseUntil = now + WEBHOOK_DELIVERY_LEASE_MS;
    await ctx.db.patch(delivery._id, {
      status: "delivering",
      leaseToken: args.leaseToken,
      leaseUntil,
    });
    // Lost claimant recovery. Wake-up can reacquire only after exact expiry.
    await ctx.scheduler.runAfter(
      WEBHOOK_DELIVERY_LEASE_MS,
      internal.webhookDeliveryAction.deliverWebhook,
      {
        deliveryId: delivery._id,
        recoveryLeaseToken: args.leaseToken,
      },
    );
    return {
      url: endpoint.url,
      encryptedSecret,
      secretVersion,
      projectId: endpoint.projectId,
      active: endpoint.active && endpoint.retiringAt === undefined,
      event: delivery.event,
      payload: delivery.payload,
      attempts: delivery.attempts,
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
    auditId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<WebhookSecretMigrationPage> => {
    const audit = await requireCompletedSecurityAudit(ctx, args.auditId);
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
      if (row._creationTime > audit.highWaterCreationTime) {
        throw new Error("Webhook row exceeds audited high-water fence");
      }
      const secretVersion = row.secretVersion ?? 1;
      const migration = await migrateStoredSecret(
        row,
        webhookBinding(row.projectId, secretVersion),
      );
      if (migration.plaintext) counts.plaintext += 1;
      if (migration.old) counts.old += 1;
      if (migration.corrupt) counts.corrupt += 1;
      if (migration.broken) counts.broken += 1;
      else counts.current += 1;
      if (migration.recovered) counts.recovered += 1;
      if (migration.rewrapped) counts.rewrapped += 1;
      if (migration.scrubbed) counts.scrubbed += 1;
      const patch: Partial<Doc<"webhookEndpoints">> = {};
      if (migration.patch) Object.assign(patch, migration.patch);

      if (row.previousSecretVersion !== undefined) {
        const previous = await migrateStoredSecret(
          previousSecretEnvelope(row),
          webhookBinding(row.projectId, row.previousSecretVersion),
        );
        if (previous.plaintext) counts.plaintext += 1;
        if (previous.old) counts.old += 1;
        if (previous.corrupt) counts.corrupt += 1;
        if (previous.broken) counts.broken += 1;
        else counts.current += 1;
        if (previous.recovered) counts.recovered += 1;
        if (previous.rewrapped) counts.rewrapped += 1;
        if (previous.scrubbed) counts.scrubbed += 1;
        if (previous.patch) {
          patch.previousCiphertext = previous.patch.ciphertext;
          patch.previousIv = previous.patch.iv;
          patch.previousKeyVersion = previous.patch.keyVersion;
          patch.previousSealedCiphertext = previous.patch.sealedCiphertext;
          patch.previousSealedIv = previous.patch.sealedIv;
          patch.previousSealedKeyVersion = previous.patch.sealedKeyVersion;
          patch.previousSealedVersion = previous.patch.sealedVersion;
        }
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
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
    leaseToken: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return;
    // Duplicate actions can race after both read `pending`. Convex retries this
    // mutation on OCC, so re-check makes result/schedule/notification exact-once.
    if (
      delivery.status !== "delivering" ||
      delivery.leaseToken !== args.leaseToken
    ) {
      return;
    }

    const nextAttempts = delivery.attempts + 1;

    if (args.ok) {
      await ctx.db.patch(args.deliveryId, {
        status: "ok",
        attempts: nextAttempts,
        leaseToken: undefined,
        leaseUntil: undefined,
      });
      return;
    }

    if (args.retryable !== false && nextAttempts < MAX_WEBHOOK_ATTEMPTS) {
      await ctx.db.patch(args.deliveryId, {
        status: "pending",
        attempts: nextAttempts,
        lastError: args.error,
        leaseToken: undefined,
        leaseUntil: undefined,
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
      leaseToken: undefined,
      leaseUntil: undefined,
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
