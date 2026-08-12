import {
  REGISTRY_ACK_SIGNATURE_HEADER,
  REGISTRY_DELIVERY_LEASE_MS,
  REGISTRY_DELIVERY_MAX_ATTEMPTS,
  REGISTRY_DELIVERY_MAX_BACKOFF_MS,
  REGISTRY_DELIVERY_TIMEOUT_MS,
  REGISTRY_EVENT_NONCE_HEADER,
  REGISTRY_EVENT_PATH,
  REGISTRY_EVENT_SIGNATURE_HEADER,
  REGISTRY_EVENT_TIMESTAMP_HEADER,
  REGISTRY_MAX_ACK_BYTES,
  REGISTRY_MAX_EVENT_BYTES,
  REGISTRY_PROTOCOL_VERSION,
  canonicalJson,
  createRegistryEvent,
  encryptRegistryCredentials,
  extractPricing,
  parseRegistryTransportKeyring,
  parseSpec,
  registryEncodedByteLength,
  registryEntityKey,
  sha256Hex,
  signRegistryEventRequest,
  validateRegistryAck,
  verifyRegistryAck,
  type JsonValue,
  type OpenApiOperation,
  type RegistryAck,
  type RegistryCatalogueListing,
  type RegistryEvent,
  type RegistryKeyLifecycle,
  type RegistryOperation,
  type RegistryPayloadMap,
  type RegistryStreamKind,
} from "@zevium/shared";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  decryptCredential,
  requireEncryptedCredential,
} from "./lib/credentialCrypto";
import {
  getActivePublicRouteBinding,
  isOrganizationActive,
  isProjectRetired,
  reservePublicRoute,
  retirePublicRoute,
} from "./lib/publicRoutes";

const MAX_ERROR_BYTES = 240;

export type RegistryEventReceipt = {
  eventId: string;
  streamKey: string;
  revision: number;
  operation: RegistryOperation;
  entityKey: string;
  payloadSha256: string;
};

type PayloadFactory<O extends RegistryOperation> = (input: {
  revision: number;
  streamKey: string;
}) => Promise<RegistryPayloadMap[O]> | RegistryPayloadMap[O];

function nextRevision(value: number | undefined): number {
  const revision = (value ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new Error("Registry stream revision is exhausted");
  return revision;
}

function terminal(operation: RegistryOperation): boolean {
  return (
    operation === "org.archive" ||
    operation === "route.archive" ||
    operation === "key.revoke"
  );
}

function streamKindForKey(streamKey: string): RegistryStreamKind {
  const kind = streamKey.split(":", 1)[0];
  if (
    kind !== "org" &&
    kind !== "route" &&
    kind !== "key" &&
    kind !== "catalogue"
  )
    throw new Error("Registry stream key is invalid");
  return kind;
}

function leaseToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function previousEventId(
  ctx: MutationCtx,
  streamKey: string,
  revision: number,
): Promise<string | undefined> {
  if (revision <= 1) return undefined;
  const previous = await ctx.db
    .query("registryOutbox")
    .withIndex("by_stream_revision", (q) =>
      q.eq("streamKey", streamKey).eq("revision", revision - 1),
    )
    .unique();
  if (previous === null)
    throw new Error("Registry stream predecessor is missing");
  return previous.eventId;
}

/** Appends complete immutable event bytes and its delivery row atomically. */
export async function enqueueRegistryEvent<O extends RegistryOperation>(
  ctx: MutationCtx,
  args: {
    operation: O;
    streamKey: string;
    payload: RegistryPayloadMap[O] | PayloadFactory<O>;
    dependsOnEventId?: string;
  },
): Promise<RegistryEventReceipt> {
  streamKindForKey(args.streamKey);
  const stream = await ctx.db
    .query("registryStreams")
    .withIndex("by_stream", (q) => q.eq("streamKey", args.streamKey))
    .unique();
  if (stream?.terminal === true) throw new Error("Registry stream is terminal");
  const revision = nextRevision(stream?.revision);
  const payload =
    typeof args.payload === "function"
      ? await args.payload({ revision, streamKey: args.streamKey })
      : args.payload;
  const event = await createRegistryEvent({
    operation: args.operation,
    streamKey: args.streamKey,
    revision,
    occurredAt: Date.now(),
    payload,
  });
  const eventJson = canonicalJson(event);
  const bodySha256 = await sha256Hex(eventJson);
  if (registryEncodedByteLength(eventJson) > REGISTRY_MAX_EVENT_BYTES)
    throw new Error("Registry event exceeds size limit");
  const dependsOnEventId =
    args.dependsOnEventId ??
    (await previousEventId(ctx, args.streamKey, revision));
  const now = Date.now();
  const entityKey = registryEntityKey(event);
  await ctx.db.insert("registryOutbox", {
    schemaVersion: REGISTRY_PROTOCOL_VERSION,
    eventId: event.eventId,
    streamKey: event.streamKey,
    revision: event.revision,
    operation: event.operation,
    occurredAt: event.occurredAt,
    nonce: event.nonce,
    payloadSha256: event.payloadSha256,
    entityKey,
    eventJson,
    bodySha256,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    dependsOnEventId,
    createdAt: now,
    updatedAt: now,
  });
  if (stream === null) {
    await ctx.db.insert("registryStreams", {
      streamKey: args.streamKey,
      revision,
      lastEventId: event.eventId,
      lastOperation: event.operation,
      payloadSha256: event.payloadSha256,
      entityKey,
      terminal: terminal(event.operation),
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(stream._id, {
      revision,
      lastEventId: event.eventId,
      lastOperation: event.operation,
      payloadSha256: event.payloadSha256,
      entityKey,
      terminal: terminal(event.operation),
      updatedAt: now,
    });
  }
  const outbox = await ctx.db
    .query("registryOutbox")
    .withIndex("by_event", (q) => q.eq("eventId", event.eventId))
    .unique();
  if (outbox === null) throw new Error("Registry outbox row was not created");
  await ctx.scheduler.runAfter(0, internal.registrySync.dispatchEvent, {
    outboxId: outbox._id,
  });
  return {
    eventId: event.eventId,
    streamKey: event.streamKey,
    revision: event.revision,
    operation: event.operation,
    entityKey,
    payloadSha256: event.payloadSha256,
  };
}

function publicHandle(org: Doc<"organizations">): string {
  const handle = org.publicHandle?.trim().toLowerCase();
  if (!handle) throw new Error("Organization has no public handle");
  return handle;
}

export async function enqueueOrgPut(
  ctx: MutationCtx,
  org: Doc<"organizations">,
): Promise<RegistryEventReceipt> {
  if (!(await isOrganizationActive(ctx, org)))
    throw new Error("Organization is archived");
  return await enqueueRegistryEvent(ctx, {
    operation: "org.put",
    streamKey: `org:${org.clerkOrgId}`,
    payload: {
      clerkOrgId: org.clerkOrgId,
      organizationId: String(org._id),
      publisherHandle: publicHandle(org),
    },
  });
}

export async function enqueueOrgArchive(
  ctx: MutationCtx,
  clerkOrgId: string,
  organizationId: string | null,
  archivedAt: number,
  reason: "clerk_deleted" | "admin_archived" = "clerk_deleted",
): Promise<RegistryEventReceipt | null> {
  const stream = await ctx.db
    .query("registryStreams")
    .withIndex("by_stream", (q) => q.eq("streamKey", `org:${clerkOrgId}`))
    .unique();
  if (stream?.terminal === true) return null;
  return await enqueueRegistryEvent(ctx, {
    operation: "org.archive",
    streamKey: `org:${clerkOrgId}`,
    payload: { clerkOrgId, organizationId, archivedAt, reason },
  });
}

async function projectRouteContext(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (
    project === null ||
    project.status !== "published" ||
    (await isProjectRetired(ctx, project))
  )
    return null;
  const org = await ctx.db.get(project.organizationId);
  if (org === null || !(await isOrganizationActive(ctx, org))) return null;
  const latest = await ctx.db
    .query("specVersions")
    .withIndex("by_project_published", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first();
  if (latest === null) return null;
  return { project, org, latest };
}

async function credentialRevision(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<number> {
  const rows = await ctx.db
    .query("upstreamCredentials")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return Math.max(1, ...rows.map((row) => row.updatedAt));
}

async function upstreamHeaders(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Record<string, string>> {
  const rows = await ctx.db
    .query("upstreamCredentials")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return Object.fromEntries(
    await Promise.all(
      rows.map(async (row) => [
        row.name,
        await decryptCredential(requireEncryptedCredential(row)),
      ]),
    ),
  );
}

export async function enqueueRoutePut(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  handleOverride?: string,
  dependsOnEventId?: string,
): Promise<RegistryEventReceipt | null> {
  const context = await projectRouteContext(ctx, projectId);
  if (context === null) return null;
  const { project, org, latest } = context;
  const handle = handleOverride ?? publicHandle(org);
  await reservePublicRoute(ctx, project, org, latest.publishedAt, handle);
  const streamKey = `route:${handle}/${project.slug}`;
  return await enqueueRegistryEvent(ctx, {
    operation: "route.put",
    streamKey,
    dependsOnEventId,
    payload: async ({ revision }) => {
      const spec = JSON.parse(latest.spec) as unknown;
      if (spec === null || typeof spec !== "object" || Array.isArray(spec))
        throw new Error("Published OpenAPI spec is invalid");
      return {
        projectId: String(project._id),
        projectGeneration: project.publicationGeneration ?? 1,
        publisherOrganizationId: String(org._id),
        publisherClerkOrgId: org.clerkOrgId,
        publisherHandle: handle,
        projectSlug: project.slug,
        specVersionId: String(latest._id),
        version: latest.version,
        publishedAt: latest.publishedAt,
        spec: spec as { readonly [key: string]: JsonValue },
        visibility: project.visibility,
        credentialRevision: await credentialRevision(ctx, projectId),
        upstreamCredentials: await encryptRegistryCredentials(
          parseRegistryTransportKeyring(
            process.env.GATEWAY_REGISTRY_TRANSPORT_KEYRING,
          ),
          streamKey,
          revision,
          await upstreamHeaders(ctx, projectId),
        ),
        admission: {
          mode:
            project.deprecationStartedAt === undefined
              ? "open"
              : "entitled_only",
          policyRevision: project.retirementRevision ?? 1,
        },
        deprecation: {
          deprecatedAt: latest.deprecatedAt ?? null,
          sunsetAt: project.sunsetAt ?? latest.sunsetAt ?? null,
          message:
            project.deprecationMessage ?? latest.deprecationMessage ?? null,
        },
      };
    },
  });
}

export async function enqueueRouteArchive(
  ctx: MutationCtx,
  project: Doc<"projects">,
  org: Doc<"organizations">,
  archivedAt: number,
  handleOverride?: string,
  replacementStreamKey: string | null = null,
): Promise<RegistryEventReceipt | null> {
  const handle = handleOverride ?? publicHandle(org);
  const streamKey = `route:${handle}/${project.slug}`;
  const stream = await ctx.db
    .query("registryStreams")
    .withIndex("by_stream", (q) => q.eq("streamKey", streamKey))
    .unique();
  if (stream?.terminal === true) return null;
  await retirePublicRoute(ctx, project, org, archivedAt, handle);
  return await enqueueRegistryEvent(ctx, {
    operation: "route.archive",
    streamKey,
    payload: {
      projectId: String(project._id),
      projectGeneration: project.publicationGeneration ?? 1,
      publisherOrganizationId: String(org._id),
      publisherClerkOrgId: org.clerkOrgId,
      publisherHandle: handle,
      projectSlug: project.slug,
      archivedAt,
      reason: replacementStreamKey === null ? "retired" : "rename",
      replacementStreamKey,
    },
  });
}

function pricing(specJson: string): RegistryCatalogueListing["pricing"] {
  const spec = parseSpec(specJson);
  let endpointCount = 0;
  let minCostCredits = Number.POSITIVE_INFINITY;
  let maxCostCredits = Number.NEGATIVE_INFINITY;
  let hasFreeTier = false;
  for (const path of Object.values(spec.paths)) {
    if (path === undefined) continue;
    for (const operation of Object.values(path)) {
      if (operation === undefined || Array.isArray(operation)) continue;
      const value = extractPricing(operation as OpenApiOperation);
      endpointCount += 1;
      minCostCredits = Math.min(minCostCredits, value.cost);
      maxCostCredits = Math.max(maxCostCredits, value.cost);
      hasFreeTier ||= (value.freeTier ?? 0) > 0;
    }
  }
  return endpointCount === 0
    ? {
        minCostCredits: 0,
        maxCostCredits: 0,
        endpointCount: 0,
        hasFreeTier: false,
      }
    : { minCostCredits, maxCostCredits, endpointCount, hasFreeTier };
}

export async function enqueueCatalogueSnapshot(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  route: RegistryEventReceipt | null = null,
): Promise<RegistryEventReceipt | null> {
  const context = await projectRouteContext(ctx, projectId);
  const project = context?.project ?? (await ctx.db.get(projectId));
  if (project === null) return null;
  const org = await ctx.db.get(project.organizationId);
  if (org === null) return null;
  const latest = await ctx.db
    .query("specVersions")
    .withIndex("by_project_published", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first();
  const discoverable =
    context !== null &&
    project.visibility === "public" &&
    project.deprecationStartedAt === undefined &&
    !(await isProjectRetired(ctx, project)) &&
    (await getActivePublicRouteBinding(ctx, org, project)) !== null;
  const listing: RegistryCatalogueListing | null =
    discoverable && latest !== null
      ? {
          projectId: String(project._id),
          publisherOrganizationId: String(org._id),
          publisherClerkOrgId: org.clerkOrgId,
          publisherHandle: publicHandle(org),
          projectSlug: project.slug,
          name: project.name,
          organizationName: org.name,
          description: project.description ?? null,
          tags: project.tags,
          publishedAt: latest.publishedAt,
          specVersionId: String(latest._id),
          version: latest.version,
          pricing: pricing(latest.spec),
          quality: null,
        }
      : null;
  return await enqueueRegistryEvent(ctx, {
    operation: "catalogue.snapshot",
    streamKey: `catalogue:${String(project._id)}`,
    dependsOnEventId: route?.eventId,
    payload: {
      projectId: String(project._id),
      projectGeneration: project.publicationGeneration ?? 1,
      route:
        route === null
          ? null
          : {
              streamKey: route.streamKey,
              revision: route.revision,
              payloadSha256: route.payloadSha256,
            },
      discoverable,
      listing,
    },
  });
}

export async function enqueuePublishedProjectProjection(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  handleOverride?: string,
  routeDependency?: string,
): Promise<{
  route: RegistryEventReceipt;
  catalogue: RegistryEventReceipt;
} | null> {
  const route = await enqueueRoutePut(
    ctx,
    projectId,
    handleOverride,
    routeDependency,
  );
  if (route === null) return null;
  const catalogue = await enqueueCatalogueSnapshot(ctx, projectId, route);
  if (catalogue === null)
    throw new Error("Published route catalogue projection failed");
  return { route, catalogue };
}

export async function enqueueKeyPut(
  ctx: MutationCtx,
  provision: RegistryPayloadMap["key.put"],
): Promise<RegistryEventReceipt> {
  return await enqueueRegistryEvent(ctx, {
    operation: "key.put",
    streamKey: `key:${provision.secretSha256}`,
    payload: provision,
  });
}

export async function enqueueKeyRevoke(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
  reason: RegistryPayloadMap["key.revoke"]["reason"],
): Promise<RegistryEventReceipt | null> {
  if (!row.secretSha256 || !row.ownerUserId || !row.budgetId)
    throw new Error("Key registry identity is incomplete");
  const streamKey = `key:${row.secretSha256}`;
  const stream = await ctx.db
    .query("registryStreams")
    .withIndex("by_stream", (q) => q.eq("streamKey", streamKey))
    .unique();
  if (stream?.terminal === true) return null;
  return await enqueueRegistryEvent(ctx, {
    operation: "key.revoke",
    streamKey,
    payload: {
      secretSha256: row.secretSha256,
      clerkKeyId: row.keyId,
      clerkOrgId: row.clerkOrgId,
      ownerUserId: row.ownerUserId,
      budgetId: row.budgetId,
      revokedAt: Date.now(),
      reason,
    },
  });
}

export async function enqueueKeyLifecycle(
  ctx: MutationCtx,
  row: Doc<"keySettings">,
  lifecycle: Exclude<RegistryKeyLifecycle, "revoked">,
): Promise<RegistryEventReceipt> {
  if (
    !row.secretSha256 ||
    !row.ownerUserId ||
    !row.subjectUserId ||
    !row.budgetId ||
    row.budgetRevision === undefined
  )
    throw new Error("Key registry identity is incomplete");
  return await enqueueRegistryEvent(ctx, {
    operation: "key.put",
    streamKey: `key:${row.secretSha256}`,
    payload: {
      secretSha256: row.secretSha256,
      clerkKeyId: row.keyId,
      clerkOrgId: row.clerkOrgId,
      ownerUserId: row.ownerUserId,
      subjectUserId: row.subjectUserId,
      budgetId: row.budgetId,
      budgetRevision: row.budgetRevision,
      lifecycle,
      monthlyCapCredits: row.monthlyCapCredits ?? null,
      graceUntil: row.graceUntil ?? null,
      expiresAt: row.expiresAt ?? null,
      scopes: ["gateway:execute"],
    },
  });
}

export const getEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("registryOutbox")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .unique(),
});

async function dependencyBlocked(
  ctx: MutationCtx,
  outbox: Doc<"registryOutbox">,
): Promise<boolean> {
  const predecessor =
    outbox.dependsOnEventId === undefined
      ? null
      : await ctx.db
          .query("registryOutbox")
          .withIndex("by_event", (q) =>
            q.eq("eventId", outbox.dependsOnEventId!),
          )
          .unique();
  if (
    outbox.dependsOnEventId !== undefined &&
    (predecessor === null || predecessor.status !== "acked")
  )
    return true;
  if (outbox.revision > 1) {
    const prior = await ctx.db
      .query("registryOutbox")
      .withIndex("by_stream_revision", (q) =>
        q.eq("streamKey", outbox.streamKey).eq("revision", outbox.revision - 1),
      )
      .unique();
    if (prior === null || prior.status !== "acked") return true;
  }
  return false;
}

export const claim = internalMutation({
  args: { outboxId: v.id("registryOutbox") },
  handler: async (ctx, args) => {
    const outbox = await ctx.db.get(args.outboxId);
    if (
      outbox === null ||
      outbox.status === "acked" ||
      outbox.status === "dead_letter"
    )
      return null;
    const now = Date.now();
    if (outbox.status === "delivering" && (outbox.leaseUntil ?? 0) > now)
      return null;
    if (outbox.status === "pending" && outbox.nextAttemptAt > now) return null;
    if (await dependencyBlocked(ctx, outbox)) return null;
    const attempts = outbox.attempts + 1;
    if (attempts > REGISTRY_DELIVERY_MAX_ATTEMPTS) {
      await ctx.db.patch(outbox._id, {
        status: "dead_letter",
        leaseUntil: undefined,
        leaseToken: undefined,
        lastErrorCode: "attempt_limit",
        updatedAt: now,
      });
      return null;
    }
    const token = leaseToken();
    await ctx.db.patch(outbox._id, {
      status: "delivering",
      attempts,
      leaseToken: token,
      leaseUntil: now + REGISTRY_DELIVERY_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      REGISTRY_DELIVERY_LEASE_MS + 1_000,
      internal.registrySync.dispatchEvent,
      { outboxId: outbox._id },
    );
    return {
      event: JSON.parse(outbox.eventJson) as RegistryEvent,
      attempt: attempts,
      leaseToken: token,
    };
  },
});

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "delivery_failed";
  return message.slice(0, MAX_ERROR_BYTES);
}

export const markAcked = internalMutation({
  args: {
    outboxId: v.id("registryOutbox"),
    attempt: v.number(),
    leaseToken: v.string(),
    ackJson: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const outbox = await ctx.db.get(args.outboxId);
    if (
      outbox === null ||
      outbox.status !== "delivering" ||
      outbox.attempts !== args.attempt ||
      outbox.leaseToken !== args.leaseToken
    )
      return false;
    const ack = JSON.parse(args.ackJson) as unknown;
    validateRegistryAck(ack);
    const event = JSON.parse(outbox.eventJson) as RegistryEvent;
    if (
      ack.bodySha256 !== outbox.bodySha256 ||
      ack.eventId !== event.eventId ||
      ack.streamKey !== event.streamKey ||
      ack.revision !== event.revision ||
      ack.operation !== event.operation ||
      ack.payloadSha256 !== event.payloadSha256 ||
      ack.entityKey !== registryEntityKey(event) ||
      (ack.status !== "applied" &&
        ack.status !== "duplicate" &&
        ack.status !== "superseded")
    )
      throw new Error("Registry acknowledgement does not match event");
    await ctx.db.patch(outbox._id, {
      status: "acked",
      leaseUntil: undefined,
      leaseToken: undefined,
      ackJson: args.ackJson,
      lastErrorCode: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const markFailed = internalMutation({
  args: {
    outboxId: v.id("registryOutbox"),
    attempt: v.number(),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const outbox = await ctx.db.get(args.outboxId);
    if (
      outbox === null ||
      outbox.status !== "delivering" ||
      outbox.attempts !== args.attempt ||
      outbox.leaseToken !== args.leaseToken
    )
      return false;
    const now = Date.now();
    if (outbox.attempts >= REGISTRY_DELIVERY_MAX_ATTEMPTS) {
      await ctx.db.patch(outbox._id, {
        status: "dead_letter",
        leaseUntil: undefined,
        leaseToken: undefined,
        lastErrorCode: errorCode(args.error),
        updatedAt: now,
      });
      return true;
    }
    const delay = Math.min(
      REGISTRY_DELIVERY_MAX_BACKOFF_MS,
      1_000 * 2 ** Math.min(outbox.attempts - 1, 10),
    );
    await ctx.db.patch(outbox._id, {
      status: "pending",
      leaseUntil: undefined,
      leaseToken: undefined,
      lastErrorCode: errorCode(args.error),
      nextAttemptAt: now + delay,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(delay, internal.registrySync.dispatchEvent, {
      outboxId: outbox._id,
    });
    return true;
  },
});

export const resumeDeadLetter = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const outbox = await ctx.db
      .query("registryOutbox")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (outbox === null || outbox.status !== "dead_letter") return false;
    await ctx.db.patch(outbox._id, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastErrorCode: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.registrySync.dispatchEvent, {
      outboxId: outbox._id,
    });
    return true;
  },
});

function endpoint(): URL {
  const base = process.env.GATEWAY_REGISTRY_SYNC_BASE_URL;
  if (!base) throw new Error("Registry sync base URL is not configured");
  const target = new URL(REGISTRY_EVENT_PATH, base);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(target.hostname)
      ))
  )
    throw new Error("Registry sync URL is invalid");
  return target;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > REGISTRY_MAX_ACK_BYTES) {
    await response.body?.cancel();
    throw new Error("Registry acknowledgement is too large");
  }
  if (response.body === null)
    throw new Error("Registry acknowledgement is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > REGISTRY_MAX_ACK_BYTES) {
      await reader.cancel();
      throw new Error("Registry acknowledgement is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseAck(raw: string): RegistryAck {
  const parsed = JSON.parse(raw) as unknown;
  if (canonicalJson(parsed) !== raw)
    throw new Error("Registry acknowledgement is not canonical JSON");
  validateRegistryAck(parsed);
  return parsed;
}

function validateDispatchAck(
  ack: RegistryAck,
  event: RegistryEvent,
  bodySha256: string,
): void {
  if (
    ack.bodySha256 !== bodySha256 ||
    ack.eventId !== event.eventId ||
    ack.streamKey !== event.streamKey ||
    ack.revision !== event.revision ||
    ack.operation !== event.operation ||
    ack.payloadSha256 !== event.payloadSha256 ||
    ack.entityKey !== registryEntityKey(event)
  )
    throw new Error("Registry acknowledgement does not match event");
  if (ack.status === "superseded" && ack.receiverRevision <= event.revision)
    throw new Error("Registry superseded acknowledgement is not ahead");
  if (
    (ack.status === "applied" || ack.status === "duplicate") &&
    ack.receiverRevision !== event.revision
  )
    throw new Error("Registry acknowledgement revision is invalid");
}

export const dispatchEvent = internalAction({
  args: { outboxId: v.id("registryOutbox") },
  handler: async (ctx, args): Promise<void> => {
    const claimed = await ctx.runMutation(internal.registrySync.claim, args);
    if (claimed === null) return;
    const secret = process.env.GATEWAY_REGISTRY_SYNC_HMAC_SECRET;
    if (!secret) {
      await ctx.runMutation(internal.registrySync.markFailed, {
        outboxId: args.outboxId,
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        error: "Registry signing secret is not configured",
      });
      return;
    }
    const timestamp = String(Date.now());
    const nonce = claimed.event.nonce;
    try {
      const signature = await signRegistryEventRequest(
        secret,
        timestamp,
        nonce,
        canonicalJson(claimed.event),
      );
      const response = await fetch(endpoint(), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(REGISTRY_DELIVERY_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          [REGISTRY_EVENT_TIMESTAMP_HEADER]: timestamp,
          [REGISTRY_EVENT_NONCE_HEADER]: nonce,
          [REGISTRY_EVENT_SIGNATURE_HEADER]: signature,
        },
        body: canonicalJson(claimed.event),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Registry receiver returned HTTP ${response.status}`);
      }
      const rawAck = await readBounded(response);
      const ackSignature =
        response.headers.get(REGISTRY_ACK_SIGNATURE_HEADER) ?? "";
      if (
        !(await verifyRegistryAck(
          secret,
          timestamp,
          nonce,
          rawAck,
          ackSignature,
        ))
      )
        throw new Error("Registry acknowledgement signature is invalid");
      const ack = parseAck(rawAck);
      const outbox = await ctx.runQuery(internal.registrySync.getEvent, {
        eventId: claimed.event.eventId,
      });
      if (outbox === null) throw new Error("Registry outbox row disappeared");
      validateDispatchAck(ack, claimed.event, outbox.bodySha256);
      await ctx.runMutation(internal.registrySync.markAcked, {
        outboxId: args.outboxId,
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        ackJson: rawAck,
      });
    } catch (error) {
      await ctx.runMutation(internal.registrySync.markFailed, {
        outboxId: args.outboxId,
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        error:
          error instanceof Error ? error.message : "Registry delivery failed",
      });
    }
  },
});
