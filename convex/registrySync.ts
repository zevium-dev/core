import {
  REGISTRY_SYNC_SCHEMA_VERSION,
  canonicalJson,
  registryPayloadDigest,
  registrySyncPath,
  sha256Hex,
  signRegistrySyncRequest,
  type RegistryKeyLifecycle,
  type RegistrySyncAck,
  type RegistrySyncOperation,
  type RegistrySyncPathOverrides,
  type RegistrySyncPayloadMap,
} from "@zevium/shared";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import {
  decryptCredential,
  requireEncryptedCredential,
} from "./lib/credentialCrypto";

const DELIVERY_LEASE_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ACK_BYTES = 64 * 1024;
const MAX_RETRY_MS = 5 * 60_000;

type LogicalRoutePayload = {
  publisherHandle: string;
  projectSlug: string;
  projectId: string;
};

export type RegistryOutboxReceipt = {
  eventId: string;
  streamKey: string;
  sourceRevision: number;
  payloadDigest: string;
};

function publicHandle(org: Doc<"organizations">): string {
  return org.publicHandle ?? org.slug;
}

function routeStreamKey(publisherHandle: string, projectSlug: string): string {
  return `route:${publisherHandle}/${projectSlug}`;
}

function keyStreamKey(keyId: string): string {
  return `key:${keyId}`;
}

/**
 * Atomically advances one logical stream and inserts its immutable outbox row.
 * Network delivery is deliberately outside the caller's transaction.
 */
export async function enqueueRegistrySync(
  ctx: MutationCtx,
  args: {
    operation: RegistrySyncOperation;
    streamKey: string;
    payload: unknown;
  },
): Promise<RegistryOutboxReceipt> {
  if (args.streamKey.length === 0 || args.streamKey.length > 512) {
    throw new Error("Registry stream key is invalid");
  }
  const payloadJson = canonicalJson(args.payload);
  if (new TextEncoder().encode(payloadJson).byteLength > 4 * 1024 * 1024) {
    throw new Error("Registry payload is too large");
  }
  const payloadDigest = await registryPayloadDigest(
    args.operation,
    args.payload,
  );
  const previous = await ctx.db
    .query("registrySyncStreams")
    .withIndex("by_stream", (q) => q.eq("streamKey", args.streamKey))
    .unique();
  const sourceRevision = (previous?.sourceRevision ?? 0) + 1;
  if (!Number.isSafeInteger(sourceRevision)) {
    throw new Error("Registry source revision is exhausted");
  }
  const occurredAt = Date.now();
  const eventId = `rs_${(await sha256Hex(args.streamKey)).slice(0, 32)}_${sourceRevision}`;
  const stream = {
    streamKey: args.streamKey,
    sourceRevision,
    operation: args.operation,
    payloadJson,
    payloadDigest,
    occurredAt,
    updatedAt: occurredAt,
  };
  if (previous === null) {
    await ctx.db.insert("registrySyncStreams", stream);
  } else {
    await ctx.db.patch(previous._id, stream);
  }
  const outboxId = await ctx.db.insert("registrySyncOutbox", {
    eventId,
    streamKey: args.streamKey,
    sourceRevision,
    operation: args.operation,
    payloadJson,
    payloadDigest,
    status: "pending",
    attempts: 0,
    nextAttemptAt: occurredAt,
    occurredAt,
    updatedAt: occurredAt,
  });
  await ctx.scheduler.runAfter(0, internal.registrySync.dispatchEvent, {
    outboxId,
  });
  return { eventId, streamKey: args.streamKey, sourceRevision, payloadDigest };
}

/** Enqueue current published route; drafts have no data-plane entry. */
export async function enqueueRouteUpsert(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<RegistryOutboxReceipt | null> {
  const project = await ctx.db.get(projectId);
  if (
    project === null ||
    project.status !== "published" ||
    project.retiringAt !== undefined
  ) {
    return null;
  }
  const org = await ctx.db.get(project.organizationId);
  if (org === null || org.retiringAt !== undefined) return null;
  const publisherHandle = publicHandle(org);
  const payload: LogicalRoutePayload = {
    publisherHandle,
    projectSlug: project.slug,
    projectId,
  };
  return await enqueueRegistrySync(ctx, {
    operation: "route.upsert",
    streamKey: routeStreamKey(publisherHandle, project.slug),
    payload,
  });
}

/** Capture routing identifiers before project rows are removed. */
export async function enqueueRouteArchive(
  ctx: MutationCtx,
  project: Doc<"projects">,
  org: Doc<"organizations">,
): Promise<RegistryOutboxReceipt> {
  const publisherHandle = publicHandle(org);
  const payload: RegistrySyncPayloadMap["route.archive"] = {
    publisherHandle,
    projectSlug: project.slug,
  };
  return await enqueueRegistrySync(ctx, {
    operation: "route.archive",
    streamKey: routeStreamKey(publisherHandle, project.slug),
    payload,
  });
}

/** Canonical org-wide fail-closed tombstone used before bounded retirement. */
export async function enqueueOrgArchive(
  ctx: MutationCtx,
  org: Doc<"organizations">,
): Promise<RegistryOutboxReceipt> {
  const payload: RegistrySyncPayloadMap["org.archive"] = {
    clerkOrgId: org.clerkOrgId,
    publisherHandle: publicHandle(org),
  };
  return await enqueueRegistrySync(ctx, {
    operation: "org.archive",
    streamKey: `org:${org.clerkOrgId}`,
    payload,
  });
}

function keySetting(row: Doc<"keySettings">) {
  return {
    disabled: row.disabled,
    ...(row.monthlyCapCredits === undefined
      ? {}
      : { monthlyCapCredits: row.monthlyCapCredits }),
    ...(row.rotatedFromKeyId === undefined
      ? {}
      : { rotatedFromKeyId: row.rotatedFromKeyId }),
    ...(row.graceUntil === undefined ? {} : { graceUntil: row.graceUntil }),
  };
}

export async function enqueueKeyUpsert(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
): Promise<RegistryOutboxReceipt> {
  const payload: RegistrySyncPayloadMap["key.upsert"] = {
    keyId: row.keyId,
    orgId: row.clerkOrgId,
    setting: keySetting(row),
  };
  return await enqueueRegistrySync(ctx, {
    operation: "key.upsert",
    streamKey: keyStreamKey(row.keyId),
    payload,
  });
}

export async function enqueueKeyState(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
  lifecycle: RegistryKeyLifecycle,
): Promise<RegistryOutboxReceipt> {
  const payload: RegistrySyncPayloadMap["key.state"] = {
    keyId: row.keyId,
    orgId: row.clerkOrgId,
    budgetId: row.clerkOrgId,
    lifecycle,
    ...(row.monthlyCapCredits === undefined
      ? {}
      : { monthlyCapCredits: row.monthlyCapCredits }),
    ...(row.graceUntil === undefined ? {} : { graceUntil: row.graceUntil }),
  };
  return await enqueueRegistrySync(ctx, {
    operation: "key.state",
    streamKey: keyStreamKey(row.keyId),
    payload,
  });
}

export const materializeRoute = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<RegistrySyncPayloadMap["route.upsert"] | null> => {
    const project = await ctx.db.get(args.projectId);
    if (
      project === null ||
      project.status !== "published" ||
      project.retiringAt !== undefined
    ) {
      return null;
    }
    const org = await ctx.db.get(project.organizationId);
    if (org === null || org.retiringAt !== undefined) return null;
    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (latest === null) return null;
    const credentials = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    const upstreamHeaders = Object.fromEntries(
      await Promise.all(
        credentials.map(async (row) => [
          row.name,
          await decryptCredential(
            requireEncryptedCredential(row),
            row.projectId,
            row.name,
          ),
        ]),
      ),
    );
    return {
      publisherHandle: publicHandle(org),
      projectSlug: project.slug,
      snapshot: {
        spec: latest.spec,
        version: latest.version,
        projectId: project._id,
        organizationId: org._id,
        clerkOrgId: org.clerkOrgId,
        visibility: project.visibility,
        upstreamHeaders,
        ...(latest.deprecatedAt === undefined
          ? {}
          : { deprecatedAt: latest.deprecatedAt }),
        ...(latest.sunsetAt === undefined ? {} : { sunsetAt: latest.sunsetAt }),
        ...(latest.deprecationMessage === undefined
          ? {}
          : { deprecationMessage: latest.deprecationMessage }),
      },
    };
  },
});

export const claim = internalMutation({
  args: { outboxId: v.id("registrySyncOutbox") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.outboxId);
    if (event === null || event.status === "delivered") return null;
    const now = Date.now();
    if (event.status === "delivering" && (event.leaseUntil ?? 0) > now) {
      return null;
    }
    if (event.status === "pending" && event.nextAttemptAt > now) {
      await ctx.scheduler.runAfter(
        event.nextAttemptAt - now,
        internal.registrySync.dispatchEvent,
        { outboxId: event._id },
      );
      return null;
    }
    const attempts = event.attempts + 1;
    await ctx.db.patch(event._id, {
      status: "delivering",
      attempts,
      leaseUntil: now + DELIVERY_LEASE_MS,
      updatedAt: now,
    });
    // Recovery wake-up covers action crashes after the lease is acquired.
    await ctx.scheduler.runAfter(
      DELIVERY_LEASE_MS + 1_000,
      internal.registrySync.dispatchEvent,
      { outboxId: event._id },
    );
    return { ...event, status: "delivering" as const, attempts };
  },
});

export const markDelivered = internalMutation({
  args: { outboxId: v.id("registrySyncOutbox"), attempt: v.number() },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.outboxId);
    if (
      event === null ||
      event.status === "delivered" ||
      event.status !== "delivering" ||
      event.attempts !== args.attempt
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(event._id, {
      status: "delivered",
      leaseUntil: undefined,
      lastError: undefined,
      deliveredAt: now,
      updatedAt: now,
    });
    return true;
  },
});

export const markFailed = internalMutation({
  args: {
    outboxId: v.id("registrySyncOutbox"),
    attempt: v.number(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.outboxId);
    if (
      event === null ||
      event.status === "delivered" ||
      event.status !== "delivering" ||
      event.attempts !== args.attempt
    ) {
      return false;
    }
    const now = Date.now();
    const delay = Math.min(
      MAX_RETRY_MS,
      1_000 * 2 ** Math.min(event.attempts, 8),
    );
    await ctx.db.patch(event._id, {
      status: "pending",
      leaseUntil: undefined,
      lastError: args.message.slice(0, 240),
      nextAttemptAt: now + delay,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(delay, internal.registrySync.dispatchEvent, {
      outboxId: event._id,
    });
    return true;
  },
});

export const getManifestPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("registrySyncStreams")
      .withIndex("by_updated")
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((stream) => ({
        eventId: `rs-manifest:${stream.streamKey}:${stream.sourceRevision}`,
        streamKey: stream.streamKey,
        sourceRevision: stream.sourceRevision,
        operation: stream.operation,
        payload: JSON.parse(stream.payloadJson) as unknown,
        payloadDigest: stream.payloadDigest,
        occurredAt: stream.occurredAt,
      })),
    };
  },
});

function parsePathOverrides(
  raw: string | undefined,
): RegistrySyncPathOverrides {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Registry path configuration is invalid");
  }
  const overrides: RegistrySyncPathOverrides = {};
  for (const [operation, path] of Object.entries(parsed)) {
    if (
      ![
        "route.upsert",
        "route.archive",
        "key.upsert",
        "key.state",
        "org.archive",
        "catalogue.replace",
      ].includes(operation) ||
      typeof path !== "string"
    ) {
      throw new Error("Registry path configuration is invalid");
    }
    overrides[operation as RegistrySyncOperation] = path;
  }
  return overrides;
}

function registryEndpoint(operation: RegistrySyncOperation): URL {
  const generic = process.env.GATEWAY_REGISTRY_SYNC_URL;
  const base = process.env.GATEWAY_REGISTRY_SYNC_BASE_URL;
  const url = generic
    ? new URL(generic)
    : new URL(
        registrySyncPath(
          operation,
          parsePathOverrides(process.env.GATEWAY_REGISTRY_SYNC_PATHS),
        ),
        base,
      );
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      ))
  ) {
    throw new Error("Registry sync endpoint is invalid");
  }
  return url;
}

function parseLogicalRoute(value: unknown): LogicalRoutePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registry route payload is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.publisherHandle !== "string" ||
    typeof row.projectSlug !== "string" ||
    typeof row.projectId !== "string"
  ) {
    throw new Error("Registry route payload is invalid");
  }
  return {
    publisherHandle: row.publisherHandle,
    projectSlug: row.projectSlug,
    projectId: row.projectId,
  };
}

async function materializePayload(
  ctx: ActionCtx,
  event: Doc<"registrySyncOutbox">,
): Promise<{
  operation: RegistrySyncOperation;
  payload: RegistrySyncPayloadMap[RegistrySyncOperation];
} | null> {
  const stored: unknown = JSON.parse(event.payloadJson);
  if (event.operation !== "route.upsert") {
    return {
      operation: event.operation,
      payload: stored as RegistrySyncPayloadMap[RegistrySyncOperation],
    };
  }
  const logical = parseLogicalRoute(stored);
  const current = await ctx.runQuery(internal.registrySync.materializeRoute, {
    projectId: logical.projectId as Id<"projects">,
  });
  if (current !== null) return { operation: "route.upsert", payload: current };
  // Deletion enqueues a newer route.archive in the same transaction that
  // removes source rows. This obsolete upsert can retire without changing its
  // signed operation or payload-digest semantics.
  return null;
}

async function boundedAck(response: Response): Promise<RegistrySyncAck> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_ACK_BYTES) {
    throw new Error("Registry acknowledgement is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Registry acknowledgement is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_ACK_BYTES) {
      await reader.cancel();
      throw new Error("Registry acknowledgement is too large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Registry acknowledgement is invalid");
  }
  const ack = parsed as Record<string, unknown>;
  if (
    !["applied", "duplicate", "stale"].includes(String(ack.status)) ||
    typeof ack.operation !== "string" ||
    typeof ack.sourceRevision !== "number"
  ) {
    throw new Error("Registry acknowledgement is invalid");
  }
  return parsed as RegistrySyncAck;
}

export const dispatchEvent = internalAction({
  args: { outboxId: v.id("registrySyncOutbox") },
  handler: async (ctx, args): Promise<void> => {
    const event = await ctx.runMutation(internal.registrySync.claim, args);
    if (event === null) return;
    try {
      const materialized = await materializePayload(ctx, event);
      if (materialized === null) {
        await ctx.runMutation(internal.registrySync.markDelivered, {
          outboxId: event._id,
          attempt: event.attempts,
        });
        return;
      }
      const endpoint = registryEndpoint(materialized.operation);
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID();
      const rawBody = canonicalJson({
        ...materialized.payload,
        schemaVersion: REGISTRY_SYNC_SCHEMA_VERSION,
        operation: materialized.operation,
        sourceRevision: event.sourceRevision,
        occurredAt: event.occurredAt,
        nonce,
        payloadDigest: event.payloadDigest,
      });
      const secret =
        process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET ??
        process.env.GATEWAY_INTERNAL_SECRET ??
        "";
      const signature = await signRegistrySyncRequest(
        secret,
        timestamp,
        nonce,
        rawBody,
      );
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-zevium-timestamp": timestamp,
          "x-zevium-nonce": nonce,
          "x-zevium-signature": signature,
        },
        body: rawBody,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Registry receiver returned HTTP ${response.status}`);
      }
      const ack = await boundedAck(response);
      if (
        ack.operation !== materialized.operation ||
        ack.sourceRevision !== event.sourceRevision
      ) {
        throw new Error("Registry acknowledgement does not match event");
      }
      await ctx.runMutation(internal.registrySync.markDelivered, {
        outboxId: event._id,
        attempt: event.attempts,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Registry delivery failed";
      console.error("registry sync delivery failed", {
        eventId: event.eventId,
        operation: event.operation,
        attempt: event.attempts,
        message,
      });
      await ctx.runMutation(internal.registrySync.markFailed, {
        outboxId: event._id,
        attempt: event.attempts,
        message,
      });
    }
  },
});
