import {
  extractHealthCheckTarget,
  parseSpec,
  type QualityIncidentContract,
  type QualitySnapshotContract,
} from "@zevium/shared";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireIdentity, requireProjectMember } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import {
  API_MINIMUM_SAMPLE_SIZE,
  QUALITY_FRESHNESS_STALE_MS,
  REACHABILITY_MINIMUM_SAMPLE_SIZE,
  qualitySnapshotContract,
} from "./lib/qualityContract";
import { syncCatalogueListing } from "./catalogue";

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const PROBE_LEASE_MS = 60 * 1000;
export const PROBE_BATCH_SIZE = 20;
export const QUALITY_WINDOW_SIZE = 24;
export const MIN_REACHABILITY_SAMPLES = REACHABILITY_MINIMUM_SAMPLE_SIZE;
export const API_QUALITY_WINDOW_SIZE = 100;
export const MIN_API_QUALITY_SAMPLES = API_MINIMUM_SAMPLE_SIZE;
export const INCIDENT_WINDOW_SIZE = 5;
export const INCIDENT_FAILURE_THRESHOLD = 3;
export const INCIDENT_RECOVERY_PASSES = 3;
export const FRESHNESS_STALE_MS = QUALITY_FRESHNESS_STALE_MS;
export const PUBLIC_PAGE_SIZE_MAX = 50;

function assertPageSize(numItems: number): void {
  if (
    !Number.isInteger(numItems) ||
    numItems < 1 ||
    numItems > PUBLIC_PAGE_SIZE_MAX
  ) {
    throw new Error(`Page size must be between 1 and ${PUBLIC_PAGE_SIZE_MAX}`);
  }
}

function isPublicListing(
  project: Doc<"projects"> | null,
): project is Doc<"projects"> {
  return (
    project !== null &&
    project.status === "published" &&
    project.visibility === "public" &&
    project.retiredAt === undefined &&
    project.qualityStatus !== "suspended" &&
    project.qualityStatus !== "recovering"
  );
}

function canActivateSubscription(
  project: Doc<"projects"> | null,
  publisher: Doc<"organizations"> | null,
): project is Doc<"projects"> {
  return (
    isPublicListing(project) &&
    project.deprecationStartedAt === undefined &&
    project.sunsetAt === undefined &&
    project.retirementState === undefined &&
    project.retiredAt === undefined &&
    project.deletionState === undefined &&
    publisher !== null &&
    publisher.archivedAt === undefined
  );
}

function percent(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function p50(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function activeOrg(ctx: QueryCtx | MutationCtx) {
  const claims = await requireIdentity(ctx);
  if (!claims.orgId) throw new Error("Choose an organization first");
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (org === null) throw new Error("Active organization is not synchronized");
  return { claims, org };
}

export const syncPublishedTarget = internalMutation({
  args: {
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
    publicationGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const project = await ctx.db.get(args.projectId);
    const version = await ctx.db.get(args.specVersionId);
    if (
      project === null ||
      version === null ||
      version.projectId !== args.projectId ||
      project.status !== "published" ||
      project.retiredAt !== undefined ||
      project.retirementState === "retired" ||
      (args.publicationGeneration !== undefined &&
        project.publicationGeneration !== args.publicationGeneration)
    ) {
      return;
    }

    // Scheduled mutations may execute out of order. An older publication must
    // never replace monitoring state for the current immutable version.
    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .first();
    if (latest === null || latest._id !== args.specVersionId) return;

    const target = await ctx.db
      .query("qualityProbeTargets")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();

    // Retry-safe: duplicate delivery for same immutable version preserves all
    // samples, incident state, lease state, and next scheduled probe.
    if (
      target?.specVersionId === args.specVersionId &&
      target.publicationGeneration === project.publicationGeneration
    )
      return;

    const now = Date.now();
    let supersededIncident: Doc<"qualityIncidents"> | null = null;
    if (target !== null) {
      const oldIncident = await ctx.db
        .query("qualityIncidents")
        .withIndex("by_project_version_status", (q) =>
          q
            .eq("projectId", args.projectId)
            .eq("specVersionId", target.specVersionId)
            .eq("status", "open"),
        )
        .unique();
      if (oldIncident !== null) {
        supersededIncident = oldIncident;
        await ctx.db.patch(oldIncident._id, {
          status: "superseded",
          closedAt: now,
          updatedAt: now,
        });
      }
    }

    let healthCheck: ReturnType<typeof extractHealthCheckTarget>;
    try {
      healthCheck = extractHealthCheckTarget(parseSpec(version.spec));
    } catch {
      if (target !== null) {
        await ctx.db.patch(target._id, {
          enabled: false,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
      }
      return;
    }
    if (healthCheck === null) {
      if (target !== null) {
        await ctx.db.patch(target._id, {
          enabled: false,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
      }
      return;
    }

    const value = {
      specVersionId: args.specVersionId,
      publicationGeneration: project.publicationGeneration,
      url: healthCheck.url,
      method: healthCheck.method,
      enabled: true,
      nextProbeAt: now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    };
    if (target)
      await ctx.db.replace(target._id, { projectId: args.projectId, ...value });
    else
      await ctx.db.insert("qualityProbeTargets", {
        projectId: args.projectId,
        ...value,
      });

    const snapshot = await ctx.db
      .query("qualitySnapshots")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const empty = {
      projectId: args.projectId,
      specVersionId: args.specVersionId,
      reachabilitySampleSize: 0,
      reachabilityResponseCount: 0,
      reachabilityPercent: undefined,
      reachabilityLatencyP50Ms: undefined,
      insufficientReachabilityData: true,
      apiSampleSize: 0,
      apiSuccessCount: 0,
      apiSuccessRatePercent: undefined,
      apiLatencyP50Ms: undefined,
      insufficientApiData: true,
      lastProbeOutcome: undefined,
      lastProbedAt: undefined,
      publishedAt: version.publishedAt,
      updatedAt: now,
    };
    if (snapshot) await ctx.db.replace(snapshot._id, empty);
    else await ctx.db.insert("qualitySnapshots", empty);

    if (
      supersededIncident !== null ||
      project.qualityStatus === "suspended" ||
      project.qualityStatus === "recovering"
    ) {
      const reason = `Replacement version needs ${INCIDENT_RECOVERY_PASSES} consecutive passing declared-health checks before relisting`;
      await ctx.db.insert("qualityIncidents", {
        projectId: args.projectId,
        specVersionId: args.specVersionId,
        specVersion: version.version,
        openedAt: now,
        status: "open",
        startedByExecutionId: `replacement:${args.specVersionId}`,
        failureCount: 0,
        lastOutcome: supersededIncident?.lastOutcome ?? "blocked_target",
        reason,
        restoreVisibility: undefined,
        threshold: INCIDENT_FAILURE_THRESHOLD,
        windowSize: INCIDENT_WINDOW_SIZE,
        suspendedAt: project.qualitySuspendedAt ?? now,
        recoveryPasses: 0,
        updatedAt: now,
      });
      await ctx.db.patch(project._id, {
        visibility: "private",
        desiredVisibility: project.desiredVisibility ?? project.visibility,
        qualityStatus: "recovering",
        qualitySuspensionReason: reason,
        qualityRecoveryPasses: 0,
      });
      await syncCatalogueListing(ctx, project._id);
    }
  },
});

export const leaseDueTargets = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{ targetId: Id<"qualityProbeTargets">; executionId: string }>
  > => {
    const now = Date.now();
    const due = await ctx.db
      .query("qualityProbeTargets")
      .withIndex("by_due", (q) => q.eq("enabled", true).lte("nextProbeAt", now))
      .take(PROBE_BATCH_SIZE);
    const expired = await ctx.db
      .query("qualityProbeTargets")
      .withIndex("by_lease_expiry", (q) =>
        q.eq("enabled", true).lte("leaseExpiresAt", now),
      )
      .take(PROBE_BATCH_SIZE);
    const candidates = Array.from(
      new Map(
        [...expired, ...due].map((target) => [target._id, target]),
      ).values(),
    ).slice(0, PROBE_BATCH_SIZE);
    const leased: Array<{
      targetId: Id<"qualityProbeTargets">;
      executionId: string;
    }> = [];
    for (const target of candidates) {
      const project = await ctx.db.get(target.projectId);
      if (project === null || project.status !== "published") {
        await ctx.db.patch(target._id, { enabled: false, updatedAt: now });
        continue;
      }
      if (
        project.retiredAt !== undefined ||
        project.retirementState === "retired" ||
        (target.publicationGeneration !== undefined &&
          target.publicationGeneration !== project.publicationGeneration)
      ) {
        await ctx.db.patch(target._id, { enabled: false, updatedAt: now });
        continue;
      }
      if (target.leaseExpiresAt !== undefined && target.leaseExpiresAt > now)
        continue;
      const executionId = crypto.randomUUID();
      await ctx.db.patch(target._id, {
        leaseId: executionId,
        leaseExpiresAt: now + PROBE_LEASE_MS,
        nextProbeAt: now + PROBE_INTERVAL_MS,
        updatedAt: now,
      });
      leased.push({ targetId: target._id, executionId });
    }
    return leased;
  },
});

export const getLeasedTarget = internalQuery({
  args: { targetId: v.id("qualityProbeTargets"), executionId: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.targetId);
    if (
      target === null ||
      !target.enabled ||
      target.leaseId !== args.executionId ||
      (target.leaseExpiresAt !== undefined &&
        target.leaseExpiresAt <= Date.now())
    )
      return null;
    return target;
  },
});

export const recordProbeResult = internalMutation({
  args: {
    targetId: v.id("qualityProbeTargets"),
    executionId: v.string(),
    outcome: v.union(
      v.literal("healthy"),
      v.literal("http_error"),
      v.literal("timeout"),
      v.literal("dns_error"),
      v.literal("tls_error"),
      v.literal("network_error"),
      v.literal("blocked_target"),
    ),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const duplicate = await ctx.db
      .query("qualityProbeResults")
      .withIndex("by_execution", (q) => q.eq("executionId", args.executionId))
      .unique();
    if (duplicate !== null) return { applied: false };
    const target = await ctx.db.get(args.targetId);
    if (
      target === null ||
      !target.enabled ||
      target.leaseId !== args.executionId ||
      (target.leaseExpiresAt !== undefined &&
        target.leaseExpiresAt <= Date.now())
    )
      return { applied: false };
    const version = await ctx.db.get(target.specVersionId);
    const project = await ctx.db.get(target.projectId);
    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", target.projectId),
      )
      .order("desc")
      .first();
    if (
      version === null ||
      version.projectId !== target.projectId ||
      project === null ||
      project.status !== "published" ||
      project.retiredAt !== undefined ||
      project.retirementState === "retired" ||
      latest?._id !== target.specVersionId ||
      target.publicationGeneration !== project.publicationGeneration
    ) {
      return { applied: false };
    }

    const hasHttpResponse = args.statusCode !== undefined;
    if (
      (args.outcome === "healthy" &&
        (!hasHttpResponse ||
          args.statusCode! < 200 ||
          args.statusCode! >= 400)) ||
      (args.outcome === "http_error" &&
        (!hasHttpResponse ||
          args.statusCode! < 400 ||
          args.statusCode! >= 600)) ||
      (args.outcome !== "healthy" &&
        args.outcome !== "http_error" &&
        hasHttpResponse) ||
      (args.latencyMs !== undefined &&
        (!Number.isFinite(args.latencyMs) || args.latencyMs < 0))
    ) {
      throw new Error("Invalid quality probe result");
    }

    const now = Date.now();
    await ctx.db.insert("qualityProbeResults", {
      projectId: target.projectId,
      specVersionId: target.specVersionId,
      publicationGeneration: target.publicationGeneration,
      executionId: args.executionId,
      checkedAt: now,
      outcome: args.outcome,
      statusCode: args.statusCode,
      latencyMs: args.latencyMs,
    });
    await ctx.db.replace(target._id, {
      projectId: target.projectId,
      specVersionId: target.specVersionId,
      publicationGeneration: target.publicationGeneration,
      url: target.url,
      method: target.method,
      enabled: target.enabled,
      nextProbeAt: target.nextProbeAt,
      updatedAt: now,
    });

    const samples = await ctx.db
      .query("qualityProbeResults")
      .withIndex("by_project_version_checked", (q) =>
        q
          .eq("projectId", target.projectId)
          .eq("specVersionId", target.specVersionId),
      )
      .order("desc")
      .take(QUALITY_WINDOW_SIZE);
    const responseCount = samples.filter(
      (sample) => sample.statusCode !== undefined,
    ).length;
    const latencies = samples.flatMap((sample) =>
      sample.statusCode === undefined || sample.latencyMs === undefined
        ? []
        : [sample.latencyMs],
    );
    const insufficientReachabilityData =
      samples.length < MIN_REACHABILITY_SAMPLES;
    const existingSnapshot = await ctx.db
      .query("qualitySnapshots")
      .withIndex("by_project", (q) => q.eq("projectId", target.projectId))
      .unique();
    const snapshotValue = {
      projectId: target.projectId,
      specVersionId: target.specVersionId,
      reachabilitySampleSize: samples.length,
      reachabilityResponseCount: responseCount,
      reachabilityPercent: insufficientReachabilityData
        ? undefined
        : percent(responseCount, samples.length),
      reachabilityLatencyP50Ms: insufficientReachabilityData
        ? undefined
        : p50(latencies),
      insufficientReachabilityData,
      apiSampleSize:
        existingSnapshot?.specVersionId === target.specVersionId
          ? existingSnapshot.apiSampleSize
          : 0,
      apiSuccessCount:
        existingSnapshot?.specVersionId === target.specVersionId
          ? existingSnapshot.apiSuccessCount
          : 0,
      apiSuccessRatePercent:
        existingSnapshot?.specVersionId === target.specVersionId
          ? existingSnapshot.apiSuccessRatePercent
          : undefined,
      apiLatencyP50Ms:
        existingSnapshot?.specVersionId === target.specVersionId
          ? existingSnapshot.apiLatencyP50Ms
          : undefined,
      insufficientApiData:
        existingSnapshot?.specVersionId === target.specVersionId
          ? existingSnapshot.insufficientApiData
          : true,
      lastProbeOutcome: args.outcome,
      lastProbedAt: now,
      publishedAt: version.publishedAt,
      updatedAt: now,
    };
    if (existingSnapshot)
      await ctx.db.replace(existingSnapshot._id, snapshotValue);
    else await ctx.db.insert("qualitySnapshots", snapshotValue);

    const openIncident = await ctx.db
      .query("qualityIncidents")
      .withIndex("by_project_version_status", (q) =>
        q
          .eq("projectId", target.projectId)
          .eq("specVersionId", target.specVersionId)
          .eq("status", "open"),
      )
      .unique();
    // Declared health operation is publisher's readiness contract. Any
    // non-2xx/3xx or transport failure is unhealthy, while reachability stays
    // a separate "did HTTP respond" metric.
    const incidentFailure = args.outcome !== "healthy";
    const failureWindow = samples.slice(0, INCIDENT_WINDOW_SIZE);
    const failuresInWindow = failureWindow.filter(
      (sample) => sample.outcome !== "healthy",
    ).length;
    if (!incidentFailure && openIncident) {
      const recoveryPasses = openIncident.recoveryPasses + 1;
      if (recoveryPasses >= INCIDENT_RECOVERY_PASSES) {
        await ctx.db.patch(openIncident._id, {
          status: "resolved",
          closedAt: now,
          resolvedByExecutionId: args.executionId,
          recoveryPasses,
          restoredAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(project._id, {
          visibility:
            project.desiredVisibility ??
            openIncident.restoreVisibility ??
            "private",
          qualityStatus: "active",
          qualitySuspendedAt: undefined,
          qualitySuspensionReason: undefined,
          qualityRecoveryPasses: undefined,
        });
        await syncCatalogueListing(ctx, project._id);
        const owner = await ctx.db.get(project.organizationId);
        if (owner !== null) {
          await createNotification(ctx, {
            clerkOrgId: owner.clerkOrgId,
            kind: "quality_restored",
            title: `${project.name} relisted`,
            body: `Declared health endpoint passed ${INCIDENT_RECOVERY_PASSES} consecutive checks. Listing access is restored.`,
            refId: `quality-restored:${openIncident._id}`,
          });
        }
      } else {
        await ctx.db.patch(openIncident._id, {
          recoveryPasses,
          updatedAt: now,
        });
        await ctx.db.patch(project._id, {
          qualityStatus: "recovering",
          qualityRecoveryPasses: recoveryPasses,
        });
      }
    } else if (incidentFailure && openIncident) {
      await ctx.db.patch(openIncident._id, {
        failureCount: openIncident.failureCount + 1,
        lastOutcome: args.outcome,
        recoveryPasses: 0,
        updatedAt: now,
      });
      await ctx.db.patch(project._id, {
        visibility: "private",
        desiredVisibility: project.desiredVisibility ?? project.visibility,
        qualityStatus: "suspended",
        qualityRecoveryPasses: 0,
      });
      await syncCatalogueListing(ctx, project._id);
    } else if (
      failureWindow.length === INCIDENT_WINDOW_SIZE &&
      failuresInWindow >= INCIDENT_FAILURE_THRESHOLD
    ) {
      const reason = `${failuresInWindow} unhealthy declared-health checks in the latest ${INCIDENT_WINDOW_SIZE}-sample window`;
      const incidentId = await ctx.db.insert("qualityIncidents", {
        projectId: target.projectId,
        specVersionId: target.specVersionId,
        specVersion: version.version,
        openedAt: now,
        status: "open",
        startedByExecutionId: args.executionId,
        failureCount: failuresInWindow,
        lastOutcome: args.outcome,
        reason,
        restoreVisibility: undefined,
        threshold: INCIDENT_FAILURE_THRESHOLD,
        windowSize: INCIDENT_WINDOW_SIZE,
        suspendedAt: now,
        recoveryPasses: incidentFailure ? 0 : 1,
        updatedAt: now,
      });
      await ctx.db.patch(project._id, {
        visibility: "private",
        desiredVisibility: project.desiredVisibility ?? project.visibility,
        qualityStatus: incidentFailure ? "suspended" : "recovering",
        qualitySuspendedAt: now,
        qualitySuspensionReason: reason,
        qualityRecoveryPasses: incidentFailure ? 0 : 1,
      });
      await syncCatalogueListing(ctx, project._id);
      const owner = await ctx.db.get(project.organizationId);
      if (owner !== null) {
        await createNotification(ctx, {
          clerkOrgId: owner.clerkOrgId,
          kind: "quality_suspended",
          title: `${project.name} suspended`,
          body: `${reason}. Zevium disabled public listing and gateway access. Recovery needs ${INCIDENT_RECOVERY_PASSES} consecutive passing checks.`,
          refId: `quality-suspended:${incidentId}`,
        });
      }
    }
    await syncCatalogueListing(ctx, project._id);
    return { applied: true };
  },
});

/**
 * Store one privacy-minimized real gateway outcome and refresh public API
 * aggregates. Raw samples never leave admin/control-plane code and deliberately
 * omit consumer, key, endpoint, payload, and exact status.
 */
async function recomputeGatewayQualitySnapshot(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  specVersionId: Id<"specVersions">,
): Promise<void> {
  const version = await ctx.db.get(specVersionId);
  if (version === null || version.projectId !== projectId) return;
  const latestVersion = await ctx.db
    .query("specVersions")
    .withIndex("by_project_published", (q) => q.eq("projectId", projectId))
    .order("desc")
    .first();
  // Gateway caches may finish calls against an older immutable version after
  // republish. Keep that raw evidence, but never let its delayed job replace
  // the one public snapshot owned by the current version.
  if (latestVersion === null || latestVersion._id !== specVersionId) return;
  const samples = await ctx.db
    .query("gatewayQualitySamples")
    .withIndex("by_project_version_at", (q) =>
      q.eq("projectId", projectId).eq("specVersionId", specVersionId),
    )
    .order("desc")
    .take(API_QUALITY_WINDOW_SIZE);
  const successCount = samples.filter(
    (sample) => sample.outcome === "success",
  ).length;
  const successfulLatencies = samples.flatMap((sample) =>
    sample.outcome === "success" ? [sample.latencyMs] : [],
  );
  const insufficientApiData = samples.length < MIN_API_QUALITY_SAMPLES;
  const existing = await ctx.db
    .query("qualitySnapshots")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  const value = {
    projectId,
    specVersionId,
    reachabilitySampleSize:
      existing?.specVersionId === specVersionId
        ? existing.reachabilitySampleSize
        : 0,
    reachabilityResponseCount:
      existing?.specVersionId === specVersionId
        ? existing.reachabilityResponseCount
        : 0,
    reachabilityPercent:
      existing?.specVersionId === specVersionId
        ? existing.reachabilityPercent
        : undefined,
    reachabilityLatencyP50Ms:
      existing?.specVersionId === specVersionId
        ? existing.reachabilityLatencyP50Ms
        : undefined,
    insufficientReachabilityData:
      existing?.specVersionId === specVersionId
        ? existing.insufficientReachabilityData
        : true,
    apiSampleSize: samples.length,
    apiSuccessCount: successCount,
    apiSuccessRatePercent: insufficientApiData
      ? undefined
      : percent(successCount, samples.length),
    apiLatencyP50Ms: insufficientApiData ? undefined : p50(successfulLatencies),
    insufficientApiData,
    lastProbeOutcome:
      existing?.specVersionId === specVersionId
        ? existing.lastProbeOutcome
        : undefined,
    lastProbedAt:
      existing?.specVersionId === specVersionId
        ? existing.lastProbedAt
        : undefined,
    publishedAt: version.publishedAt,
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("qualitySnapshots", value);
  await syncCatalogueListing(ctx, projectId);
}

export const recomputeGatewayQuality = internalMutation({
  args: {
    projectId: v.id("projects"),
    specVersionId: v.id("specVersions"),
  },
  handler: async (ctx, args): Promise<void> => {
    await recomputeGatewayQualitySnapshot(
      ctx,
      args.projectId,
      args.specVersionId,
    );
  },
});

export const runDueProbes = internalAction({
  args: {},
  handler: async (ctx): Promise<{ attempted: number; failed: number }> => {
    const targets = await ctx.runMutation(internal.quality.leaseDueTargets, {});
    let failed = 0;
    for (const target of targets) {
      try {
        await ctx.runAction(
          internal.qualityProbeAction.runScheduledProbe,
          target,
        );
      } catch (error) {
        failed += 1;
        console.error(
          `[quality] scheduled probe failed for ${target.targetId}`,
          error,
        );
      }
    }
    return { attempted: targets.length, failed };
  },
});

export const getPublicSnapshot = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<QualitySnapshotContract | null> => {
    const project = await ctx.db.get(args.projectId);
    if (!isPublicListing(project)) return null;
    const snapshot = await ctx.db
      .query("qualitySnapshots")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (snapshot === null) return null;
    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .first();
    return latest === null || latest._id !== snapshot.specVersionId
      ? null
      : qualitySnapshotContract(snapshot);
  },
});

export const listPublicIncidents = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    assertPageSize(args.paginationOpts.numItems);
    const project = await ctx.db.get(args.projectId);
    if (!isPublicListing(project)) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("qualityIncidents")
      .withIndex("by_project_opened", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page: QualityIncidentContract[] = [];
    for (const incident of result.page) {
      page.push({
        id: incident._id,
        version: incident.specVersion ?? "unknown",
        openedAt: incident.openedAt,
        closedAt: incident.closedAt ?? null,
        status: incident.status,
        failureCount: incident.failureCount,
        lastOutcome: incident.lastOutcome,
        reason: incident.reason,
        threshold: incident.threshold,
        windowSize: incident.windowSize,
      });
    }
    return { ...result, page };
  },
});

async function applySubscriptionDelta(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  delta: -1 | 1,
): Promise<void> {
  const aggregate = await ctx.db
    .query("listingSubscriptionAggregates")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  const nextCount = (aggregate?.count ?? 0) + delta;
  if (nextCount < 0) throw new Error("Subscription aggregate invariant failed");
  if (aggregate === null) {
    await ctx.db.insert("listingSubscriptionAggregates", {
      projectId,
      count: nextCount,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.patch(aggregate._id, {
      count: nextCount,
      updatedAt: Date.now(),
    });
  }
}

export const setSubscription = mutation({
  args: { projectId: v.id("projects"), active: v.boolean() },
  handler: async (ctx, args) => {
    const { claims, org } = await activeOrg(ctx);
    const project = await ctx.db.get(args.projectId);
    if (project?.deletionState !== undefined) {
      throw new Error("Project subscription cleanup has started");
    }
    const existing = await ctx.db
      .query("listingSubscriptions")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    const now = Date.now();
    if (!args.active && existing === null) return null;
    if (!args.active && existing !== null) {
      if (existing.active) {
        await ctx.db.patch(existing._id, { active: false, updatedAt: now });
        await applySubscriptionDelta(ctx, args.projectId, -1);
      }
      return (await ctx.db.get(existing._id))!;
    }
    const publisher =
      project === null ? null : await ctx.db.get(project.organizationId);
    if (args.active && !canActivateSubscription(project, publisher)) {
      throw new Error("Published listing not found");
    }
    if (project === null) throw new Error("Published listing not found");
    if (existing) {
      if (existing.active !== args.active) {
        await ctx.db.patch(existing._id, {
          active: args.active,
          updatedAt: now,
        });
        await applySubscriptionDelta(ctx, args.projectId, args.active ? 1 : -1);
      }
      return (await ctx.db.get(existing._id))!;
    }
    const id = await ctx.db.insert("listingSubscriptions", {
      consumerOrganizationId: org._id,
      projectId: args.projectId,
      active: args.active,
      createdBy: claims.subject,
      createdAt: now,
      updatedAt: now,
    });
    if (args.active) await applySubscriptionDelta(ctx, args.projectId, 1);
    return (await ctx.db.get(id))!;
  },
});

export const listSubscriptions = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertPageSize(args.paginationOpts.numItems);
    const { org } = await activeOrg(ctx);
    return await ctx.db
      .query("listingSubscriptions")
      .withIndex("by_consumer_active", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("active", true),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const subscriberCount = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<number> => {
    await requireProjectMember(ctx, args.projectId);
    const aggregate = await ctx.db
      .query("listingSubscriptionAggregates")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    return aggregate?.count ?? 0;
  },
});
