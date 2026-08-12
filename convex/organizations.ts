import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireIdentity, requireOrgAdmin } from "./lib/auth";
import { isValidSlug } from "./lib/validate";

const CONTROL_MANIFEST_PAGE_SIZE = 100;
const CONTROL_RETRY_BATCH_SIZE = 50;
const CONTROL_DELIVERY_LEASE_MS = 30_000;
const CONTROL_MAX_BACKOFF_MS = 15 * 60_000;

export type GatewayControlOperation =
  | "org.state"
  | "org.archive"
  | "route.upsert"
  | "route.archive"
  | "key.upsert"
  | "key.state"
  | "spec.state"
  | "catalogue.state";

const CONTROL_ROUTES: Record<GatewayControlOperation, string> = {
  "org.state": "/internal/registry/v1/org/state",
  "org.archive": "/internal/registry/v1/org/archive",
  "route.upsert": "/internal/registry/v1/route",
  "route.archive": "/internal/registry/v1/route/archive",
  "key.upsert": "/internal/registry/v1/key",
  "key.state": "/internal/registry/v1/key/state",
  "spec.state": "/internal/registry/v1/route",
  "catalogue.state": "/internal/registry/v1/catalogue",
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("Control payload is not JSON-safe");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function safeNextRevision(current: number | undefined): number {
  const revision = (current ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("Gateway control revision exhausted");
  }
  return revision;
}

/**
 * Transactionally update org control state and enqueue one immutable edge event.
 * Security/spec producers import this helper; receiver-specific logic stays out.
 */
export async function enqueueGatewayControl(
  ctx: MutationCtx,
  args: {
    clerkOrgId: string;
    operation: GatewayControlOperation;
    /** Stable receiver entity identity, e.g. `org:org_123` or `route:projectId`. */
    entityKey?: string;
    /** Required for non-org producers; must be positive and monotonic per entity. */
    sourceRevision?: number;
    archived?: boolean;
    publisherHandle?: string;
    payload?: Record<string, unknown>;
    route?: string;
  },
): Promise<{ outboxId: Id<"gatewayControlOutbox">; sourceRevision: number }> {
  const now = Date.now();
  const control = await ctx.db
    .query("gatewayOrgControls")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
    .unique();
  const organization = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
    .unique();
  const isOrgOperation =
    args.operation === "org.state" || args.operation === "org.archive";
  const entityKey = args.entityKey ?? `org:${args.clerkOrgId}`;
  const sourceRevision =
    args.sourceRevision ??
    (isOrgOperation ? safeNextRevision(control?.sourceRevision) : 0);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
    throw new Error(
      "Non-org gateway control producers require a positive sourceRevision",
    );
  }
  if (
    isOrgOperation &&
    control !== null &&
    sourceRevision <= control.sourceRevision
  ) {
    throw new Error("Gateway org control revision must increase");
  }
  const archived =
    args.archived ??
    (isOrgOperation
      ? (control?.archived ?? organization?.archivedAt !== undefined)
      : undefined);
  const publisherHandle =
    args.publisherHandle ??
    (isOrgOperation
      ? (control?.publisherHandle ?? organization?.publicHandle)
      : undefined);

  const payload = canonicalJson({
    ...(args.payload ?? {}),
    archived,
    clerkOrgId: args.clerkOrgId,
    entityKey,
    operation: args.operation,
    publisherHandle,
    schemaVersion: 1,
    sourceRevision,
  });
  const existingOutbox = await ctx.db
    .query("gatewayControlOutbox")
    .withIndex("by_entity_revision_operation", (q) =>
      q
        .eq("entityKey", entityKey)
        .eq("sourceRevision", sourceRevision)
        .eq("operation", args.operation),
    )
    .unique();
  if (existingOutbox !== null) {
    if (existingOutbox.payload !== payload) {
      throw new Error("Gateway control revision payload conflict");
    }
    return { outboxId: existingOutbox._id, sourceRevision };
  }
  const latestForEntity = await ctx.db
    .query("gatewayControlOutbox")
    .withIndex("by_entity_revision_operation", (q) =>
      q.eq("entityKey", entityKey),
    )
    .order("desc")
    .first();
  if (
    latestForEntity !== null &&
    sourceRevision <= latestForEntity.sourceRevision
  ) {
    throw new Error("Gateway control sourceRevision must increase per entity");
  }

  if (isOrgOperation) {
    if (control === null) {
      await ctx.db.insert("gatewayOrgControls", {
        clerkOrgId: args.clerkOrgId,
        sourceRevision,
        archived: archived ?? false,
        publisherHandle,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(control._id, {
        sourceRevision,
        archived: archived ?? false,
        publisherHandle,
        updatedAt: now,
      });
    }
  }
  const outboxId = await ctx.db.insert("gatewayControlOutbox", {
    clerkOrgId: args.clerkOrgId,
    entityKey,
    sourceRevision,
    operation: args.operation,
    route: args.route ?? CONTROL_ROUTES[args.operation],
    payload,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(
    0,
    internal.organizations.deliverGatewayControlOutbox,
    { outboxId },
  );
  return { outboxId, sourceRevision };
}

async function ensureWallet(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Id<"wallets">> {
  const existing = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (existing !== null) {
    return existing._id;
  }
  return await ctx.db.insert("wallets", {
    organizationId,
    balance: 0,
    sequence: 0,
  });
}

export type PublicOrganization = {
  name: string;
  publisherHandle: string;
  imageUrl: string | undefined;
};

export type MineOrganization = PublicOrganization & {
  publicHandleLocked: boolean;
};

export const getByPublicHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<PublicOrganization | null> => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) =>
        q.eq("publicHandle", args.handle.trim().toLowerCase()),
      )
      .unique();
    if (
      org === null ||
      org.archivedAt !== undefined ||
      org.publicHandle === undefined
    ) {
      return null;
    }
    return {
      name: org.name,
      publisherHandle: org.publicHandle,
      imageUrl: org.imageUrl,
    };
  },
});

/** Auth-scoped availability probe; never exposes another organization record. */
export const checkPublicHandleAvailability = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<{ available: boolean }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) throw new Error("No active organization");
    const handle = args.handle.trim().toLowerCase();
    const current = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (current?.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
      .unique();
    return { available: existing === null || existing._id === current?._id };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx): Promise<MineOrganization[]> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) {
      return [];
    }
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (
      org === null ||
      org.archivedAt !== undefined ||
      org.publicHandle === undefined
    ) {
      return [];
    }
    const publishedProject = await ctx.db
      .query("projects")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", org._id).eq("status", "published"),
      )
      .first();
    return [
      {
        name: org.name,
        publisherHandle: org.publicHandle,
        imageUrl: org.imageUrl,
        publicHandleLocked: publishedProject !== null,
      },
    ];
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"organizations"> | null> => {
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (tombstone !== null) {
      // Clerk events are not ordered. A delete tombstone permanently wins over
      // late create/update delivery and prevents tenant resurrection.
      return existing?._id ?? null;
    }

    if (existing === null) {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug: args.slug,
        publicHandle: args.slug,
        imageUrl: args.imageUrl,
      });
      await ensureWallet(ctx, organizationId);
      await enqueueGatewayControl(ctx, {
        clerkOrgId: args.clerkOrgId,
        operation: "org.state",
        archived: false,
        publisherHandle: args.slug,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId, cursor: null },
      );
      return organizationId;
    }

    if (existing.archivedAt !== undefined) {
      // A late/out-of-order update must never resurrect a Clerk-deleted org.
      return existing._id;
    }

    await ctx.db.patch(existing._id, {
      name: args.name,
      slug: args.slug,
      ...(existing.publicHandle === undefined
        ? { publicHandle: args.slug }
        : {}),
      imageUrl: args.imageUrl,
    });
    await ensureWallet(ctx, existing._id);
    if (existing.publicHandle === undefined) {
      await enqueueGatewayControl(ctx, {
        clerkOrgId: args.clerkOrgId,
        operation: "org.state",
        archived: false,
        publisherHandle: args.slug,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
    return existing._id;
  },
});

/**
 * Atomic Svix receipt + ordered organization mirror write. A transaction error
 * rolls the receipt back, so provider retry never strands an unprocessed event.
 */
export const applyOrganizationWebhook = internalMutation({
  args: {
    svixId: v.string(),
    eventTimestamp: v.number(),
    eventType: v.union(
      v.literal("organization.created"),
      v.literal("organization.updated"),
      v.literal("organization.deleted"),
    ),
    clerkOrgId: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (
      args.svixId.trim() === "" ||
      !Number.isSafeInteger(args.eventTimestamp) ||
      args.eventTimestamp <= 0
    ) {
      throw new Error("Invalid Clerk webhook envelope");
    }
    const priorReceipt = await ctx.db
      .query("clerkWebhookReceipts")
      .withIndex("by_svix_id", (q) => q.eq("svixId", args.svixId))
      .unique();
    if (priorReceipt !== null) {
      return { status: "duplicate" as const };
    }
    const now = Date.now();
    const receiptId = await ctx.db.insert("clerkWebhookReceipts", {
      svixId: args.svixId,
      eventType: args.eventType,
      eventTimestamp: args.eventTimestamp,
      status: "processing",
      attempts: 1,
      lastAttemptAt: now,
      receivedAt: now,
    });
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (args.eventType === "organization.deleted") {
      const tombstone = await ctx.db
        .query("organizationTombstones")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .unique();
      if (tombstone === null) {
        await ctx.db.insert("organizationTombstones", {
          clerkOrgId: args.clerkOrgId,
          archivedAt: now,
        });
      }
      if (existing !== null && existing.archivedAt === undefined) {
        await ctx.db.patch(existing._id, {
          archivedAt: now,
          lastClerkEventAt: Math.max(
            existing.lastClerkEventAt ?? 0,
            args.eventTimestamp,
          ),
        });
      }
      if (existing !== null) {
        await ctx.scheduler.runAfter(
          0,
          internal.catalogue.syncOrganizationCataloguePage,
          { organizationId: existing._id, cursor: null },
        );
      }
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.disableArchivedOrgKeysPage,
        { clerkOrgId: args.clerkOrgId, cursor: null },
      );
      const control = await ctx.db
        .query("gatewayOrgControls")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .unique();
      if (control?.archived !== true) {
        await enqueueGatewayControl(ctx, {
          clerkOrgId: args.clerkOrgId,
          operation: "org.archive",
          archived: true,
          publisherHandle: existing?.publicHandle,
          payload: { archivedAt: existing?.archivedAt ?? now },
        });
      }
      await ctx.db.patch(receiptId, {
        status: "processed",
        processedAt: now,
      });
      return { status: "processed" as const };
    }

    if (args.name === undefined || args.slug === undefined) {
      throw new Error("Clerk organization payload is incomplete");
    }
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (
      tombstone !== null ||
      existing?.archivedAt !== undefined ||
      (existing?.lastClerkEventAt !== undefined &&
        args.eventTimestamp < existing.lastClerkEventAt)
    ) {
      await ctx.db.patch(receiptId, {
        status: "ignored_stale",
        processedAt: now,
      });
      return { status: "ignored_stale" as const };
    }

    if (existing === null) {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug: args.slug,
        publicHandle: args.slug,
        imageUrl: args.imageUrl,
        lastClerkEventAt: args.eventTimestamp,
        unreadNotificationCount: 0,
      });
      await ensureWallet(ctx, organizationId);
      await enqueueGatewayControl(ctx, {
        clerkOrgId: args.clerkOrgId,
        operation: "org.state",
        archived: false,
        publisherHandle: args.slug,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId, cursor: null },
      );
    } else {
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        ...(existing.publicHandle === undefined
          ? { publicHandle: args.slug }
          : {}),
        imageUrl: args.imageUrl,
        lastClerkEventAt: args.eventTimestamp,
      });
      await ensureWallet(ctx, existing._id);
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId: existing._id, cursor: null },
      );
    }
    await ctx.db.patch(receiptId, {
      status: "processed",
      processedAt: now,
    });
    return { status: "processed" as const };
  },
});

export const archiveFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const priorControl = await ctx.db
      .query("gatewayOrgControls")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (tombstone === null) {
      await ctx.db.insert("organizationTombstones", {
        clerkOrgId: args.clerkOrgId,
        archivedAt: now,
      });
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    await ctx.scheduler.runAfter(
      0,
      internal.organizations.disableArchivedOrgKeysPage,
      { clerkOrgId: args.clerkOrgId, cursor: null },
    );
    if (existing === null) {
      if (priorControl?.archived !== true) {
        await enqueueGatewayControl(ctx, {
          clerkOrgId: args.clerkOrgId,
          operation: "org.archive",
          archived: true,
          payload: { archivedAt: now },
        });
      }
      return;
    }

    if (existing.archivedAt === undefined) {
      await ctx.db.patch(existing._id, { archivedAt: now });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
    if (priorControl?.archived !== true) {
      await enqueueGatewayControl(ctx, {
        clerkOrgId: args.clerkOrgId,
        operation: "org.archive",
        archived: true,
        publisherHandle: existing.publicHandle,
        payload: { archivedAt: existing.archivedAt ?? now },
      });
    }
  },
});

/** Bounded continuation job; safe under retries and concurrent archive events. */
export const disableArchivedOrgKeysPage = internalMutation({
  args: {
    clerkOrgId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ disabled: number; done: boolean }> => {
    const page = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .paginate({ cursor: args.cursor, numItems: 100 });
    const now = Date.now();
    for (const setting of page.page) {
      if (setting.disabled) continue;
      await ctx.db.patch(setting._id, {
        disabled: true,
        updatedAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.disableArchivedOrgKeysPage,
        { clerkOrgId: args.clerkOrgId, cursor: page.continueCursor },
      );
    }
    return { disabled: page.page.length, done: page.isDone };
  },
});

/** Lease one delivery attempt. Duplicate scheduled jobs become no-ops. */
export const claimGatewayControlDelivery = internalMutation({
  args: { outboxId: v.id("gatewayControlOutbox") },
  handler: async (ctx, args) => {
    const outbox = await ctx.db.get(args.outboxId);
    const now = Date.now();
    if (
      outbox === null ||
      outbox.status === "acked" ||
      outbox.nextAttemptAt > now
    ) {
      return null;
    }
    const attempts = outbox.attempts + 1;
    if (!Number.isSafeInteger(attempts)) {
      throw new Error("Gateway control delivery attempts exhausted");
    }
    await ctx.db.patch(outbox._id, {
      attempts,
      nextAttemptAt: now + CONTROL_DELIVERY_LEASE_MS,
      updatedAt: now,
    });
    return {
      outboxId: outbox._id,
      clerkOrgId: outbox.clerkOrgId,
      sourceRevision: outbox.sourceRevision,
      operation: outbox.operation,
      route: outbox.route,
      payload: outbox.payload,
      attempts,
    };
  },
});

export const acknowledgeGatewayControlDelivery = internalMutation({
  args: {
    outboxId: v.id("gatewayControlOutbox"),
    sourceRevision: v.number(),
    payloadDigest: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const outbox = await ctx.db.get(args.outboxId);
    if (outbox === null || outbox.status === "acked") return;
    if (outbox.sourceRevision !== args.sourceRevision) {
      throw new Error("Gateway control acknowledgement revision mismatch");
    }
    const now = Date.now();
    await ctx.db.patch(outbox._id, {
      status: "acked",
      payloadDigest: args.payloadDigest,
      lastError: undefined,
      ackedAt: now,
      updatedAt: now,
    });
  },
});

export const failGatewayControlDelivery = internalMutation({
  args: {
    outboxId: v.id("gatewayControlOutbox"),
    payloadDigest: v.optional(v.string()),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const outbox = await ctx.db.get(args.outboxId);
    if (outbox === null || outbox.status === "acked") return;
    const exponent = Math.min(outbox.attempts, 10);
    const backoff = Math.min(2 ** exponent * 1_000, CONTROL_MAX_BACKOFF_MS);
    const now = Date.now();
    await ctx.db.patch(outbox._id, {
      payloadDigest: args.payloadDigest ?? outbox.payloadDigest,
      lastError: args.error.slice(0, 240),
      nextAttemptAt: now + backoff,
      updatedAt: now,
    });
  },
});

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function signGatewayControl(
  secret: string,
  timestamp: string,
  nonce: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${payload}`),
  );
  return `v1=${bytesToHex(signature)}`;
}

/** Signed producer delivery. Receiver acks exact immutable sourceRevision. */
export const deliverGatewayControlOutbox = internalAction({
  args: { outboxId: v.id("gatewayControlOutbox") },
  handler: async (ctx, args): Promise<{ delivered: boolean }> => {
    const delivery = await ctx.runMutation(
      internal.organizations.claimGatewayControlDelivery,
      args,
    );
    if (delivery === null) return { delivered: false };

    const baseUrl = process.env.GATEWAY_CONTROL_BASE_URL?.trim();
    const secret = process.env.GATEWAY_INTERNAL_SECRET?.trim();
    const payloadDigest = await sha256Hex(delivery.payload);
    if (!baseUrl || !secret) {
      await ctx.runMutation(internal.organizations.failGatewayControlDelivery, {
        outboxId: delivery.outboxId,
        payloadDigest,
        error: "gateway control delivery is not configured",
      });
      return { delivered: false };
    }

    try {
      const target = new URL(delivery.route, baseUrl);
      if (
        target.protocol !== "https:" &&
        target.hostname !== "localhost" &&
        target.hostname !== "127.0.0.1"
      ) {
        throw new Error("gateway control URL must use HTTPS");
      }
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID();
      const signature = await signGatewayControl(
        secret,
        timestamp,
        nonce,
        delivery.payload,
      );
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zevium-control-digest": `sha256=${payloadDigest}`,
          "x-zevium-nonce": nonce,
          "x-zevium-signature": signature,
          "x-zevium-timestamp": timestamp,
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`gateway returned HTTP ${response.status}`);
      }
      const ack: unknown = await response.json();
      if (
        ack === null ||
        typeof ack !== "object" ||
        !("status" in ack) ||
        !["applied", "duplicate", "stale"].includes(String(ack.status)) ||
        !("sourceRevision" in ack) ||
        ack.sourceRevision !== delivery.sourceRevision ||
        !("operation" in ack) ||
        ack.operation !== delivery.operation
      ) {
        throw new Error("gateway returned invalid control acknowledgement");
      }
      await ctx.runMutation(
        internal.organizations.acknowledgeGatewayControlDelivery,
        {
          outboxId: delivery.outboxId,
          sourceRevision: delivery.sourceRevision,
          payloadDigest,
        },
      );
      return { delivered: true };
    } catch (error) {
      await ctx.runMutation(internal.organizations.failGatewayControlDelivery, {
        outboxId: delivery.outboxId,
        payloadDigest,
        error: error instanceof Error ? error.message : "delivery failed",
      });
      return { delivered: false };
    }
  },
});

/** Cron-safe bounded retry scheduler. Network work stays in separate actions. */
export const retryGatewayControlOutbox = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const due = await ctx.db
      .query("gatewayControlOutbox")
      .withIndex("by_status_next_attempt", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", Date.now()),
      )
      .take(CONTROL_RETRY_BATCH_SIZE);
    for (const outbox of due) {
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.deliverGatewayControlOutbox,
        { outboxId: outbox._id },
      );
    }
    return { scheduled: due.length };
  },
});

/**
 * Version-pinned bootstrap manifest. Any concurrent producer bump makes the
 * next page stale so the receiver restarts rather than mixing snapshots.
 */
export const getGatewayControlManifestPage = internalQuery({
  args: {
    clerkOrgId: v.string(),
    sourceRevision: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const control = await ctx.db
      .query("gatewayOrgControls")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (
      control === null ||
      !Number.isSafeInteger(args.sourceRevision) ||
      args.sourceRevision <= 0 ||
      control.sourceRevision !== args.sourceRevision
    ) {
      return {
        status: "stale" as const,
        currentRevision: control?.sourceRevision ?? 0,
      };
    }
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const wallet =
      organization === null
        ? null
        : await ctx.db
            .query("wallets")
            .withIndex("by_organization", (q) =>
              q.eq("organizationId", organization._id),
            )
            .unique();
    const settings = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .paginate({
        cursor: args.cursor,
        numItems: CONTROL_MANIFEST_PAGE_SIZE,
        maximumRowsRead: CONTROL_MANIFEST_PAGE_SIZE + 1,
      });
    return {
      status: "ok" as const,
      schemaVersion: 1,
      clerkOrgId: args.clerkOrgId,
      sourceRevision: control.sourceRevision,
      archived: control.archived,
      publisherHandle: control.publisherHandle,
      wallet: {
        balance: wallet?.balance ?? 0,
        sequence: wallet?.sequence ?? 0,
      },
      keySettings: settings.page.map((setting) => ({
        keyId: setting.keyId,
        monthlyCapCredits: setting.monthlyCapCredits,
        disabled: setting.disabled,
        rotatedFromKeyId: setting.rotatedFromKeyId,
        graceUntil: setting.graceUntil,
      })),
      continueCursor: settings.continueCursor,
      isDone: settings.isDone,
    };
  },
});

/**
 * Called by web app with the active Clerk org.
 * Identity must be present; clerkOrgId must match a claim on the JWT
 * (org_id) so clients cannot invent orgs for other tenants.
 */
export const ensureOrganization = mutation({
  args: {
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"organizations">> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) {
      throw new Error("Organization does not match authenticated identity");
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (existing === null) {
      const tombstone = await ctx.db
        .query("organizationTombstones")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .unique();
      if (tombstone !== null) {
        throw new Error("Organization is archived");
      }
      const signedSlug = claims.orgSlug?.trim().toLowerCase();
      if (signedSlug === undefined || !isValidSlug(signedSlug)) {
        throw new Error(
          "Active organization is awaiting Clerk synchronization",
        );
      }
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: signedSlug,
        slug: signedSlug,
        publicHandle: signedSlug,
      });
      await ensureWallet(ctx, organizationId);
      await enqueueGatewayControl(ctx, {
        clerkOrgId: args.clerkOrgId,
        operation: "org.state",
        archived: false,
        publisherHandle: signedSlug,
      });
      const created = await ctx.db.get(organizationId);
      if (created === null) {
        throw new Error("Failed to load created organization");
      }
      return created;
    }
    if (existing.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    await ensureWallet(ctx, existing._id);
    return existing;
  },
});

/** Update only the canonical public routing handle, never Clerk's slug. */
export const setPublicHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations">> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId) throw new Error("No active organization on identity");
    const handle = args.handle.trim().toLowerCase();
    if (!isValidSlug(handle)) {
      throw new Error("Public handle must be kebab-case");
    }
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (!organization) throw new Error("Organization not found");
    if (organization.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    if (organization.publicHandle === handle) return organization;
    const publishedProject = await ctx.db
      .query("projects")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", organization._id).eq("status", "published"),
      )
      .first();
    if (publishedProject !== null) {
      throw new Error("Public handle is permanent after first publication");
    }
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
      .unique();
    if (existing && existing._id !== organization._id) {
      throw new Error("That public handle is already in use");
    }
    await ctx.db.patch(organization._id, {
      publicHandle: handle,
    });
    await enqueueGatewayControl(ctx, {
      clerkOrgId: organization.clerkOrgId,
      operation: "org.state",
      archived: false,
      publisherHandle: handle,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: organization._id, cursor: null },
    );
    const updated = await ctx.db.get(organization._id);
    if (!updated) throw new Error("Organization not found");
    return updated;
  },
});

/** One-shot migration before publicHandle becomes required. */
export const backfillPublicHandles = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; collisions: number }> => {
    const page = await ctx.db.query("organizations").paginate({
      cursor: args.cursor ?? null,
      numItems: 100,
      maximumRowsRead: 101,
    });
    let updated = 0;
    let collisions = 0;
    for (const organization of page.page) {
      if (organization.publicHandle !== undefined) continue;
      const normalized = organization.slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const base = normalized || "publisher";
      let handle = base;
      const taken = await ctx.db
        .query("organizations")
        .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
        .unique();
      if (taken !== null) {
        collisions += 1;
        handle = `${base}-${organization._id
          .slice(-10)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")}`;
      }
      await ctx.db.patch(organization._id, { publicHandle: handle });
      updated += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.backfillPublicHandles,
        { cursor: page.continueCursor },
      );
    }
    return { updated, collisions };
  },
});
