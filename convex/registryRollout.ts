import {
  REGISTRY_ROLLOUT_BATCH_SIZE,
  canonicalJson,
  registryGenesisDigest,
  sha256Hex,
  type RegistryKeyLifecycle,
  type RegistryOperation,
  type RegistryRolloutCounts,
  type RegistryRolloutDigests,
  type RegistryRolloutManifest,
} from "@zevium/shared";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  getOrganizationTombstone,
  isOrganizationActive,
  isProjectRetired,
  resolveRolloutPublicHandle,
} from "./lib/publicRoutes";
import {
  enqueueCatalogueSnapshot,
  enqueueKeyLifecycle,
  enqueueOrgArchive,
  enqueueOrgPut,
  enqueuePublishedProjectProjection,
  enqueueRouteArchive,
} from "./registrySync";

const ROLLOUT_KEY = "registry-v2-initial";
const PROVENANCE_VERSION = 1 as const;
type ProductionPhase = "credentials" | "organizations" | "routes" | "keys";

function zeroCounts(): RegistryRolloutCounts {
  return {
    credentials: 0,
    organizations: 0,
    archivedOrganizations: 0,
    handlesBackfilled: 0,
    handlesReassigned: 0,
    publishedRoutes: 0,
    retiredRoutes: 0,
    keys: 0,
    keysForcedToRotate: 0,
    events: 0,
  };
}
function zeroDigests(): RegistryRolloutDigests {
  return { sources: registryGenesisDigest(), events: registryGenesisDigest() };
}
function requireProvenance(
  rollout: Doc<"registryRollouts">,
): asserts rollout is Doc<"registryRollouts"> & {
  provenanceVersion: 1;
  page: number;
  verification: NonNullable<Doc<"registryRollouts">["verification"]>;
} {
  if (
    rollout.provenanceVersion !== PROVENANCE_VERSION ||
    rollout.page === undefined ||
    rollout.verification === undefined
  )
    throw new Error("Registry rollout provenance upgrade is required");
}
export function toRegistryRolloutManifest(
  rollout: Doc<"registryRollouts">,
): RegistryRolloutManifest {
  requireProvenance(rollout);
  return {
    schemaVersion: 2,
    provenanceVersion: 1,
    rolloutId: rollout.rolloutId,
    snapshotAt: rollout.snapshotAt,
    status: rollout.status,
    phase: rollout.phase,
    cursor: rollout.cursor ?? null,
    page: rollout.page,
    counts: rollout.counts,
    digests: rollout.digests,
    verification: {
      counts: rollout.verification.counts,
      digests: rollout.verification.digests,
      lastPage: rollout.verification.lastPage ?? null,
      lastOrdinal: rollout.verification.lastOrdinal ?? null,
    },
    ...(rollout.completedAt === undefined
      ? {}
      : { completedAt: rollout.completedAt }),
  };
}
async function chain(
  previous: string,
  domain: "source" | "event",
  value: unknown,
): Promise<string> {
  return await sha256Hex(
    canonicalJson({
      purpose: `zevium-registry-rollout-${domain}-v2`,
      previous,
      value,
    }),
  );
}
function addCounts(
  current: RegistryRolloutCounts,
  delta: RegistryRolloutCounts,
): RegistryRolloutCounts {
  const result = { ...current };
  for (const key of Object.keys(result) as Array<keyof RegistryRolloutCounts>)
    result[key] += delta[key];
  return result;
}
function delta(value: Partial<RegistryRolloutCounts>): RegistryRolloutCounts {
  return { ...zeroCounts(), ...value };
}
async function source(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
  input: {
    page: number;
    ordinal: number;
    phase: ProductionPhase;
    sourceId: string;
    value: unknown;
    delta: RegistryRolloutCounts;
    digest: string;
    counts: RegistryRolloutCounts;
  },
): Promise<{ digest: string; counts: RegistryRolloutCounts }> {
  const existing = await ctx.db
    .query("registryRolloutSourcePreimages")
    .withIndex("by_rollout_source", (q) =>
      q
        .eq("rolloutId", rollout.rolloutId)
        .eq("phase", input.phase)
        .eq("sourceId", input.sourceId),
    )
    .unique();
  if (existing !== null)
    throw new Error("Registry rollout source provenance is duplicated");
  const preimage = {
    schemaVersion: 2,
    rolloutId: rollout.rolloutId,
    page: input.page,
    ordinal: input.ordinal,
    phase: input.phase,
    sourceId: input.sourceId,
    source: input.value,
    countDelta: input.delta,
  };
  await ctx.db.insert("registryRolloutSourcePreimages", {
    rolloutId: rollout.rolloutId,
    page: input.page,
    ordinal: input.ordinal,
    phase: input.phase,
    sourceId: input.sourceId,
    preimageJson: canonicalJson(preimage),
    countDelta: input.delta,
  });
  return {
    digest: await chain(input.digest, "source", preimage),
    counts: addCounts(input.counts, input.delta),
  };
}
async function receipt(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
  input: {
    page: number;
    ordinal: number;
    sourceOrdinal: number;
    event: {
      eventId: string;
      streamKey: string;
      revision: number;
      operation: RegistryOperation;
      payloadSha256: string;
    } | null;
    digest: string;
    counts: RegistryRolloutCounts;
  },
): Promise<{ digest: string; counts: RegistryRolloutCounts }> {
  if (input.event === null)
    return { digest: input.digest, counts: input.counts };
  const existing = await ctx.db
    .query("registryRolloutEventReceipts")
    .withIndex("by_rollout_event", (q) =>
      q.eq("rolloutId", rollout.rolloutId).eq("eventId", input.event!.eventId),
    )
    .unique();
  if (existing !== null)
    throw new Error("Registry rollout event provenance is duplicated");
  const value = {
    eventId: input.event.eventId,
    streamKey: input.event.streamKey,
    revision: input.event.revision,
    operation: input.event.operation,
    payloadSha256: input.event.payloadSha256,
  };
  const preimage = {
    schemaVersion: 2,
    rolloutId: rollout.rolloutId,
    page: input.page,
    ordinal: input.ordinal,
    sourceOrdinal: input.sourceOrdinal,
    receipt: value,
  };
  await ctx.db.insert("registryRolloutEventReceipts", {
    rolloutId: rollout.rolloutId,
    page: input.page,
    ordinal: input.ordinal,
    sourceOrdinal: input.sourceOrdinal,
    ...value,
    receiptJson: canonicalJson(preimage),
  });
  return {
    digest: await chain(input.digest, "event", preimage),
    counts: addCounts(input.counts, delta({ events: 1 })),
  };
}
async function load(
  ctx: MutationCtx,
  rolloutId: string,
): Promise<Doc<"registryRollouts">> {
  const row = await ctx.db
    .query("registryRollouts")
    .withIndex("by_key", (q) => q.eq("key", ROLLOUT_KEY))
    .unique();
  if (row === null || row.rolloutId !== rolloutId)
    throw new Error("Registry rollout not found");
  requireProvenance(row);
  return row;
}
async function schedule(
  ctx: MutationCtx,
  row: Doc<"registryRollouts">,
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    row.phase === "verify_sources" || row.phase === "verify_events"
      ? internal.registryRollout.verifyStep
      : internal.registryRollout.runStep,
    { rolloutId: row.rolloutId },
  );
}
async function persist(
  ctx: MutationCtx,
  row: Doc<"registryRollouts">,
  patch: Partial<Doc<"registryRollouts">>,
): Promise<RegistryRolloutManifest> {
  await ctx.db.patch(row._id, { ...patch, updatedAt: Date.now() });
  const updated = await ctx.db.get(row._id);
  if (updated === null) throw new Error("Registry rollout disappeared");
  requireProvenance(updated);
  if (updated.status === "running") await schedule(ctx, updated);
  return toRegistryRolloutManifest(updated);
}

export const startOrResume = internalMutation({
  args: {},
  handler: async (ctx): Promise<RegistryRolloutManifest> => {
    const existing = await ctx.db
      .query("registryRollouts")
      .withIndex("by_key", (q) => q.eq("key", ROLLOUT_KEY))
      .unique();
    if (existing !== null) {
      requireProvenance(existing);
      if (existing.status === "running") await schedule(ctx, existing);
      return toRegistryRolloutManifest(existing);
    }
    const now = Date.now();
    const id = await ctx.db.insert("registryRollouts", {
      key: ROLLOUT_KEY,
      rolloutId: crypto.randomUUID(),
      provenanceVersion: 1,
      snapshotAt: now,
      status: "running",
      phase: "credentials",
      page: 0,
      counts: zeroCounts(),
      digests: zeroDigests(),
      verification: { counts: zeroCounts(), digests: zeroDigests() },
      startedAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(id);
    if (row === null) throw new Error("Failed to create registry rollout");
    requireProvenance(row);
    await schedule(ctx, row);
    return toRegistryRolloutManifest(row);
  },
});
export const get = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("registryRollouts")
      .withIndex("by_key", (q) => q.eq("key", ROLLOUT_KEY))
      .unique();
    return row === null ? null : toRegistryRolloutManifest(row);
  },
});

async function pageRows<T extends { _creationTime: number }>(
  ctx: MutationCtx,
  table: "upstreamCredentials" | "organizations" | "projects" | "keySettings",
  cursor: string | undefined,
  snapshotAt: number,
): Promise<{ page: T[]; continueCursor: string; isDone: boolean }> {
  const result = await ctx.db
    .query(table)
    .order("asc")
    .paginate({
      cursor: cursor ?? null,
      numItems: REGISTRY_ROLLOUT_BATCH_SIZE,
      maximumRowsRead: REGISTRY_ROLLOUT_BATCH_SIZE,
    });
  return {
    page: result.page.filter(
      (row) => row._creationTime <= snapshotAt,
    ) as unknown as T[],
    continueCursor: result.continueCursor,
    isDone:
      result.isDone ||
      result.page.some((row) => row._creationTime > snapshotAt),
  };
}

async function runCredentials(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  const page = (rollout.page ?? 0) + 1;
  const rows = await pageRows<Doc<"upstreamCredentials">>(
    ctx,
    "upstreamCredentials",
    rollout.cursor,
    rollout.snapshotAt,
  );
  let counts = rollout.counts;
  let digest = rollout.digests.sources;
  for (let ordinal = 0; ordinal < rows.page.length; ordinal += 1) {
    const row = rows.page[ordinal]!;
    if (!row.ciphertext || !row.iv || !row.keyVersion)
      throw new Error(`Credential ${row._id} is not safely encrypted`);
    const result = await source(ctx, rollout, {
      page,
      ordinal,
      phase: "credentials",
      sourceId: String(row._id),
      value: {
        kind: "credential",
        credentialId: String(row._id),
        projectId: String(row.projectId),
        name: row.name,
        keyVersion: row.keyVersion,
      },
      delta: delta({ credentials: 1 }),
      digest,
      counts,
    });
    digest = result.digest;
    counts = result.counts;
  }
  return await persist(ctx, rollout, {
    page,
    counts,
    digests: { ...rollout.digests, sources: digest },
    ...(rows.isDone
      ? { phase: "organizations", cursor: undefined }
      : { cursor: rows.continueCursor }),
  });
}
async function runOrganizations(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  const page = (rollout.page ?? 0) + 1;
  const rows = await pageRows<Doc<"organizations">>(
    ctx,
    "organizations",
    rollout.cursor,
    rollout.snapshotAt,
  );
  let counts = rollout.counts;
  let sourceDigest = rollout.digests.sources;
  let eventDigest = rollout.digests.events;
  let eventOrdinal = 0;
  for (let ordinal = 0; ordinal < rows.page.length; ordinal += 1) {
    let row = rows.page[ordinal]!;
    const handle = await resolveRolloutPublicHandle(ctx, row);
    const changed =
      row.publicHandle === undefined
        ? "backfilled"
        : row.publicHandle === handle
          ? "none"
          : "reassigned";
    if (row.publicHandle !== handle) {
      await ctx.db.patch(row._id, { publicHandle: handle });
      row = (await ctx.db.get(row._id))!;
    }
    const tombstone = await getOrganizationTombstone(ctx, row.clerkOrgId);
    const archivedAt = tombstone?.archivedAt ?? row.archivedAt;
    const event =
      archivedAt === undefined
        ? await enqueueOrgPut(ctx, row)
        : await enqueueOrgArchive(
            ctx,
            row.clerkOrgId,
            String(row._id),
            archivedAt,
          );
    const eventResult = await receipt(ctx, rollout, {
      page,
      ordinal: eventOrdinal++,
      sourceOrdinal: ordinal,
      event,
      digest: eventDigest,
      counts,
    });
    eventDigest = eventResult.digest;
    counts = eventResult.counts;
    const sourceValue = {
      kind: "organization",
      organizationId: String(row._id),
      clerkOrgId: row.clerkOrgId,
      publisherHandle: handle,
      changed,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    };
    const sourceResult = await source(ctx, rollout, {
      page,
      ordinal,
      phase: "organizations",
      sourceId: String(row._id),
      value: sourceValue,
      delta: delta({
        organizations: 1,
        archivedOrganizations: archivedAt === undefined ? 0 : 1,
        handlesBackfilled: changed === "backfilled" ? 1 : 0,
        handlesReassigned: changed === "reassigned" ? 1 : 0,
      }),
      digest: sourceDigest,
      counts,
    });
    sourceDigest = sourceResult.digest;
    counts = sourceResult.counts;
  }
  return await persist(ctx, rollout, {
    page,
    counts,
    digests: { sources: sourceDigest, events: eventDigest },
    ...(rows.isDone
      ? { phase: "routes", cursor: undefined }
      : { cursor: rows.continueCursor }),
  });
}
async function runRoutes(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  const page = (rollout.page ?? 0) + 1;
  const rows = await pageRows<Doc<"projects">>(
    ctx,
    "projects",
    rollout.cursor,
    rollout.snapshotAt,
  );
  let counts = rollout.counts;
  let sourceDigest = rollout.digests.sources;
  let eventDigest = rollout.digests.events;
  let eventOrdinal = 0;
  for (let ordinal = 0; ordinal < rows.page.length; ordinal += 1) {
    const project = rows.page[ordinal]!;
    if (project.status !== "published") continue;
    const org = await ctx.db.get(project.organizationId);
    if (org === null) throw new Error("Published route has no organization");
    const retired =
      !(await isOrganizationActive(ctx, org)) ||
      (await isProjectRetired(ctx, project));
    const route = retired
      ? await enqueueRouteArchive(
          ctx,
          project,
          org,
          project.retiredAt ?? org.archivedAt ?? Date.now(),
        )
      : ((await enqueuePublishedProjectProjection(ctx, project._id))?.route ??
        null);
    const catalogue = retired
      ? await enqueueCatalogueSnapshot(ctx, project._id, route)
      : null;
    for (const event of [route, catalogue]) {
      const result = await receipt(ctx, rollout, {
        page,
        ordinal: eventOrdinal++,
        sourceOrdinal: ordinal,
        event,
        digest: eventDigest,
        counts,
      });
      eventDigest = result.digest;
      counts = result.counts;
    }
    const result = await source(ctx, rollout, {
      page,
      ordinal,
      phase: "routes",
      sourceId: String(project._id),
      value: {
        kind: "route",
        projectId: String(project._id),
        organizationId: String(org._id),
        retired,
      },
      delta: delta({ publishedRoutes: 1, retiredRoutes: retired ? 1 : 0 }),
      digest: sourceDigest,
      counts,
    });
    sourceDigest = result.digest;
    counts = result.counts;
  }
  return await persist(ctx, rollout, {
    page,
    counts,
    digests: { sources: sourceDigest, events: eventDigest },
    ...(rows.isDone
      ? { phase: "keys", cursor: undefined }
      : { cursor: rows.continueCursor }),
  });
}
async function runKeys(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  const page = (rollout.page ?? 0) + 1;
  const rows = await pageRows<Doc<"keySettings">>(
    ctx,
    "keySettings",
    rollout.cursor,
    rollout.snapshotAt,
  );
  let counts = rollout.counts;
  let sourceDigest = rollout.digests.sources;
  let eventDigest = rollout.digests.events;
  let eventOrdinal = 0;
  for (let ordinal = 0; ordinal < rows.page.length; ordinal += 1) {
    let row = rows.page[ordinal]!;
    const forced =
      row.secretSha256 === undefined ||
      row.ownerUserId === undefined ||
      row.subjectUserId === undefined ||
      row.budgetId === undefined ||
      row.budgetRevision === undefined;
    let event = null;
    if (forced) {
      if (!row.disabled || row.lifecycle !== "disabled") {
        await ctx.db.patch(row._id, {
          disabled: true,
          lifecycle: "disabled",
          rotationRequiredAt: Date.now(),
          updatedAt: Date.now(),
        });
        row = (await ctx.db.get(row._id))!;
      }
    } else {
      const stream = await ctx.db
        .query("registryStreams")
        .withIndex("by_stream", (q) =>
          q.eq("streamKey", `key:${row.secretSha256}`),
        )
        .unique();
      event =
        stream === null
          ? await enqueueKeyLifecycle(
              ctx,
              row,
              (row.lifecycle === "grace" || row.lifecycle === "active"
                ? row.lifecycle
                : "disabled") as Exclude<RegistryKeyLifecycle, "revoked">,
            )
          : null;
    }
    const eventResult = await receipt(ctx, rollout, {
      page,
      ordinal: eventOrdinal++,
      sourceOrdinal: ordinal,
      event,
      digest: eventDigest,
      counts,
    });
    eventDigest = eventResult.digest;
    counts = eventResult.counts;
    const sourceResult = await source(ctx, rollout, {
      page,
      ordinal,
      phase: "keys",
      sourceId: String(row._id),
      value: {
        kind: "key",
        keyId: row.keyId,
        clerkOrgId: row.clerkOrgId,
        forced,
      },
      delta: delta({ keys: 1, keysForcedToRotate: forced ? 1 : 0 }),
      digest: sourceDigest,
      counts,
    });
    sourceDigest = sourceResult.digest;
    counts = sourceResult.counts;
  }
  return await persist(ctx, rollout, {
    page,
    counts,
    digests: { sources: sourceDigest, events: eventDigest },
    ...(rows.isDone
      ? { phase: "verify_sources", cursor: undefined }
      : { cursor: rows.continueCursor }),
  });
}

function parse(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(value) !== raw
  )
    throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}
async function verifySources(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  requireProvenance(rollout);
  const result = await ctx.db
    .query("registryRolloutSourcePreimages")
    .withIndex("by_rollout_order", (q) => q.eq("rolloutId", rollout.rolloutId))
    .order("asc")
    .paginate({
      cursor: rollout.cursor ?? null,
      numItems: REGISTRY_ROLLOUT_BATCH_SIZE,
      maximumRowsRead: REGISTRY_ROLLOUT_BATCH_SIZE,
    });
  let verification = rollout.verification;
  for (const row of result.page) {
    const value = parse(row.preimageJson, "Registry rollout source preimage");
    if (
      value.schemaVersion !== 2 ||
      value.rolloutId !== row.rolloutId ||
      value.page !== row.page ||
      value.ordinal !== row.ordinal ||
      value.phase !== row.phase ||
      value.sourceId !== row.sourceId ||
      canonicalJson(value.countDelta) !== canonicalJson(row.countDelta)
    )
      throw new Error("Registry rollout source preimage binding is invalid");
    verification = {
      counts: addCounts(verification.counts, row.countDelta),
      digests: {
        ...verification.digests,
        sources: await chain(verification.digests.sources, "source", value),
      },
      lastPage: row.page,
      lastOrdinal: row.ordinal,
    };
  }
  if (!result.isDone)
    return await persist(ctx, rollout, {
      cursor: result.continueCursor,
      verification,
    });
  const verifiedCounts = { ...verification.counts, events: 0 };
  const expectedCounts = { ...rollout.counts, events: 0 };
  if (
    canonicalJson(verifiedCounts) !== canonicalJson(expectedCounts) ||
    verification.digests.sources !== rollout.digests.sources
  )
    throw new Error("Registry rollout source verification mismatch");
  return await persist(ctx, rollout, {
    phase: "verify_events",
    cursor: undefined,
    verification: {
      ...verification,
      lastPage: undefined,
      lastOrdinal: undefined,
    },
  });
}
async function verifyEvents(
  ctx: MutationCtx,
  rollout: Doc<"registryRollouts">,
): Promise<RegistryRolloutManifest> {
  requireProvenance(rollout);
  const result = await ctx.db
    .query("registryRolloutEventReceipts")
    .withIndex("by_rollout_order", (q) => q.eq("rolloutId", rollout.rolloutId))
    .order("asc")
    .paginate({
      cursor: rollout.cursor ?? null,
      numItems: REGISTRY_ROLLOUT_BATCH_SIZE,
      maximumRowsRead: REGISTRY_ROLLOUT_BATCH_SIZE,
    });
  let verification = rollout.verification;
  for (const row of result.page) {
    const value = parse(row.receiptJson, "Registry rollout event receipt");
    const receiptValue = value.receipt as Record<string, unknown>;
    const event = await ctx.db
      .query("registryOutbox")
      .withIndex("by_event", (q) => q.eq("eventId", row.eventId))
      .unique();
    if (
      value.schemaVersion !== 2 ||
      value.rolloutId !== row.rolloutId ||
      receiptValue.eventId !== row.eventId ||
      receiptValue.streamKey !== row.streamKey ||
      receiptValue.revision !== row.revision ||
      receiptValue.operation !== row.operation ||
      receiptValue.payloadSha256 !== row.payloadSha256 ||
      event === null ||
      event.eventJson.length === 0
    )
      throw new Error("Registry rollout receipt event is missing or changed");
    verification = {
      counts: addCounts(verification.counts, delta({ events: 1 })),
      digests: {
        ...verification.digests,
        events: await chain(verification.digests.events, "event", value),
      },
      lastPage: row.page,
      lastOrdinal: row.ordinal,
    };
  }
  if (!result.isDone)
    return await persist(ctx, rollout, {
      cursor: result.continueCursor,
      verification,
    });
  if (
    canonicalJson(verification.counts) !== canonicalJson(rollout.counts) ||
    canonicalJson(verification.digests) !== canonicalJson(rollout.digests)
  )
    throw new Error("Registry rollout event verification mismatch");
  return await persist(ctx, rollout, {
    phase: "complete",
    status: "complete",
    cursor: undefined,
    verification,
    completedAt: Date.now(),
  });
}

export const runStep = internalMutation({
  args: { rolloutId: v.string() },
  handler: async (ctx, args): Promise<RegistryRolloutManifest> => {
    const rollout = await load(ctx, args.rolloutId);
    if (rollout.status === "complete")
      return toRegistryRolloutManifest(rollout);
    switch (rollout.phase) {
      case "credentials":
        return await runCredentials(ctx, rollout);
      case "organizations":
        return await runOrganizations(ctx, rollout);
      case "routes":
        return await runRoutes(ctx, rollout);
      case "keys":
        return await runKeys(ctx, rollout);
      default:
        throw new Error("Registry rollout requires verifier step");
    }
  },
});
export const verifyStep = internalMutation({
  args: { rolloutId: v.string() },
  handler: async (ctx, args): Promise<RegistryRolloutManifest> => {
    const rollout = await load(ctx, args.rolloutId);
    if (rollout.status === "complete")
      return toRegistryRolloutManifest(rollout);
    if (rollout.phase === "verify_sources")
      return await verifySources(ctx, rollout);
    if (rollout.phase === "verify_events")
      return await verifyEvents(ctx, rollout);
    throw new Error("Registry rollout is not ready for verification");
  },
});
