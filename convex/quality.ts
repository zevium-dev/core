import {
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
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireIdentity, requireProjectMember } from "./lib/auth";

export const PROBE_INTERVAL_MS = 5 * 60 * 1000;
export const PROBE_LEASE_MS = 60 * 1000;
export const PROBE_BATCH_SIZE = 20;
export const QUALITY_WINDOW_SIZE = 24;
export const MIN_QUALITY_SAMPLES = 3;
export const FRESHNESS_STALE_MS = 30 * 24 * 60 * 60 * 1000;
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

function percent(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function p50(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function activeOrg(ctx: Parameters<typeof requireIdentity>[0]) {
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
  args: { projectId: v.id("projects"), specVersionId: v.id("specVersions") },
  handler: async (ctx, args): Promise<void> => {
    const project = await ctx.db.get(args.projectId);
    const version = await ctx.db.get(args.specVersionId);
    if (
      project === null ||
      version === null ||
      version.projectId !== args.projectId ||
      project.status !== "published"
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
    if (target?.specVersionId === args.specVersionId) return;

    const now = Date.now();
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
        await ctx.db.patch(oldIncident._id, {
          status: "superseded",
          closedAt: now,
          updatedAt: now,
        });
      }
    }

    let url: string;
    try {
      url = parseSpec(version.spec).servers[0]?.url ?? "";
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
    if (url === "") {
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
      url,
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
      sampleSize: 0,
      responseCount: 0,
      successCount: 0,
      availabilityPercent: undefined,
      successRatePercent: undefined,
      latencyP50Ms: undefined,
      insufficientData: true,
      lastOutcome: undefined,
      lastCheckedAt: undefined,
      publishedAt: version.publishedAt,
      updatedAt: now,
    };
    if (snapshot) await ctx.db.replace(snapshot._id, empty);
    else await ctx.db.insert("qualitySnapshots", empty);
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
    const leased: Array<{
      targetId: Id<"qualityProbeTargets">;
      executionId: string;
    }> = [];
    for (const target of due) {
      const project = await ctx.db.get(target.projectId);
      if (project === null || project.status !== "published") {
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
      target.leaseId !== args.executionId
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
      v.literal("success"),
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
      target.leaseId !== args.executionId
    )
      return { applied: false };
    const version = await ctx.db.get(target.specVersionId);
    const project = await ctx.db.get(target.projectId);
    if (
      version === null ||
      version.projectId !== target.projectId ||
      project === null ||
      project.status !== "published"
    ) {
      return { applied: false };
    }

    const hasHttpResponse = args.statusCode !== undefined;
    if (
      (args.outcome === "success" &&
        (!hasHttpResponse ||
          args.statusCode! < 200 ||
          args.statusCode! >= 400)) ||
      (args.outcome === "http_error" &&
        (!hasHttpResponse ||
          args.statusCode! < 400 ||
          args.statusCode! >= 600)) ||
      (args.outcome !== "success" &&
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
      executionId: args.executionId,
      checkedAt: now,
      outcome: args.outcome,
      statusCode: args.statusCode,
      latencyMs: args.latencyMs,
    });
    await ctx.db.replace(target._id, {
      projectId: target.projectId,
      specVersionId: target.specVersionId,
      url: target.url,
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
    const successCount = samples.filter(
      (sample) => sample.outcome === "success",
    ).length;
    const latencies = samples.flatMap((sample) =>
      sample.statusCode === undefined || sample.latencyMs === undefined
        ? []
        : [sample.latencyMs],
    );
    const insufficientData = samples.length < MIN_QUALITY_SAMPLES;
    const snapshotValue = {
      projectId: target.projectId,
      specVersionId: target.specVersionId,
      sampleSize: samples.length,
      responseCount,
      successCount,
      availabilityPercent: insufficientData
        ? undefined
        : percent(responseCount, samples.length),
      successRatePercent: insufficientData
        ? undefined
        : percent(successCount, responseCount),
      latencyP50Ms: insufficientData ? undefined : p50(latencies),
      insufficientData,
      lastOutcome: args.outcome,
      lastCheckedAt: now,
      publishedAt: version.publishedAt,
      updatedAt: now,
    };
    const snapshot = await ctx.db
      .query("qualitySnapshots")
      .withIndex("by_project", (q) => q.eq("projectId", target.projectId))
      .unique();
    if (snapshot) await ctx.db.replace(snapshot._id, snapshotValue);
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
    // 4xx commonly means credential enforcement or HEAD unsupported. It proves
    // availability, but never counts as HTTP success. Incidents represent
    // outages: transport failures or 5xx responses.
    const incidentFailure =
      args.statusCode === undefined || args.statusCode >= 500;
    if (!incidentFailure) {
      if (openIncident) {
        await ctx.db.patch(openIncident._id, {
          status: "resolved",
          closedAt: now,
          resolvedByExecutionId: args.executionId,
          updatedAt: now,
        });
      }
    } else if (openIncident) {
      await ctx.db.patch(openIncident._id, {
        failureCount: openIncident.failureCount + 1,
        lastOutcome: args.outcome,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("qualityIncidents", {
        projectId: target.projectId,
        specVersionId: target.specVersionId,
        openedAt: now,
        status: "open",
        startedByExecutionId: args.executionId,
        failureCount: 1,
        lastOutcome: args.outcome,
        updatedAt: now,
      });
    }
    return { applied: true };
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

export function toQualitySnapshotContract(
  snapshot: Doc<"qualitySnapshots">,
  now = Date.now(),
): QualitySnapshotContract {
  const ageMs = Math.max(0, now - snapshot.publishedAt);
  return {
    sampleSize: snapshot.sampleSize,
    availabilityPercent: snapshot.availabilityPercent ?? null,
    successRatePercent: snapshot.successRatePercent ?? null,
    latencyP50Ms: snapshot.latencyP50Ms ?? null,
    insufficientData: snapshot.insufficientData,
    lastOutcome: snapshot.lastOutcome ?? null,
    lastCheckedAt: snapshot.lastCheckedAt ?? null,
    freshness: {
      publishedAt: snapshot.publishedAt,
      ageMs,
      status: ageMs > FRESHNESS_STALE_MS ? "stale" : "fresh",
    },
  };
}

export const getPublicSnapshot = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<QualitySnapshotContract | null> => {
    const project = await ctx.db.get(args.projectId);
    if (
      project === null ||
      project.status !== "published" ||
      project.visibility !== "public"
    )
      return null;
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
      : toQualitySnapshotContract(snapshot);
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
    if (
      project === null ||
      project.status !== "published" ||
      project.visibility !== "public"
    ) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("qualityIncidents")
      .withIndex("by_project_opened", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page: QualityIncidentContract[] = [];
    for (const incident of result.page) {
      const version = await ctx.db.get(incident.specVersionId);
      page.push({
        id: incident._id,
        version: version?.version ?? "unknown",
        openedAt: incident.openedAt,
        closedAt: incident.closedAt ?? null,
        status: incident.status,
        failureCount: incident.failureCount,
        lastOutcome: incident.lastOutcome,
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
    if (
      project === null ||
      project.status !== "published" ||
      project.visibility !== "public"
    ) {
      throw new Error("Published listing not found");
    }
    const existing = await ctx.db
      .query("listingSubscriptions")
      .withIndex("by_consumer_project", (q) =>
        q.eq("consumerOrganizationId", org._id).eq("projectId", args.projectId),
      )
      .unique();
    const now = Date.now();
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
