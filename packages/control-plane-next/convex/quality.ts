import { extractHealthCheckTarget, parseSpec } from "@zevium/shared";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectMember } from "./lib/auth";
import { isActive } from "./lib/identity";
import { listing, syncCatalogue } from "./lib/catalogue";
import { createNotification } from "./lib/notifications";
import { qualitySnapshotContract } from "./lib/qualityContract";
export const PROBE_INTERVAL_MS = 300000,
  PROBE_LEASE_MS = 60000;
const outcome = v.union(
  ...(
    [
      "healthy",
      "http_error",
      "network_error",
      "timeout",
      "blocked_target",
      "dns_error",
      "tls_error",
    ] as const
  ).map(v.literal),
);
const median = (values: number[]) =>
  values.length
    ? values.sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
    : undefined;
async function recompute(ctx: MutationCtx, project: Doc<"projects">) {
  if (!project.latestVersionId) return;
  const probes = await ctx.db
    .query("qualityEvents")
    .withIndex("by_version_kind_time", (q) =>
      q
        .eq("projectId", project._id)
        .eq("specVersionId", project.latestVersionId!)
        .eq("kind", "probe"),
    )
    .order("desc")
    .take(24);
  const samples = await ctx.db
    .query("usageEvents")
    .withIndex("by_project_version_time", (q) =>
      q
        .eq("projectId", project._id)
        .eq("specVersionId", project.latestVersionId!),
    )
    .order("desc")
    .take(100);
  const measured = samples.filter(
    (s) =>
      s.billingOutcome !== "exception" &&
      s.consumerOrganizationId !== s.publisherOrganizationId,
  );
  const health = probes.filter(
    (p): p is Extract<Doc<"qualityEvents">, { kind: "probe" }> =>
      p.kind === "probe",
  );
  const apiEnough = measured.length >= 20,
    probeEnough = health.length >= 3;
  const snapshot = {
    specVersionId: project.latestVersionId,
    reachabilitySampleSize: health.length,
    reachabilityPercent: probeEnough
      ? (100 * health.filter((p) => p.statusCode !== undefined).length) /
        health.length
      : undefined,
    reachabilityLatencyP50Ms: probeEnough
      ? median(
          health.flatMap((p) =>
            p.latencyMs === undefined ? [] : [p.latencyMs],
          ),
        )
      : undefined,
    insufficientReachabilityData: !probeEnough,
    apiSampleSize: measured.length,
    apiSuccessRatePercent: apiEnough
      ? (100 * measured.filter((s) => s.qualityOutcome === "success").length) /
        measured.length
      : undefined,
    apiLatencyP50Ms: apiEnough
      ? median(measured.map((s) => s.latencyMs))
      : undefined,
    insufficientApiData: !apiEnough,
    lastProbeOutcome: health[0]?.outcome,
    lastProbedAt: health[0]?.at,
    publishedAt: project.publishedAt ?? 0,
    updatedAt: Math.max(
      health[0]?.at ?? 0,
      ...measured.map((s) => s.at),
      project.publishedAt ?? 0,
    ),
  };
  await ctx.db.patch(project._id, {
    quality: { ...project.quality, snapshot },
  });
}
export async function setupQuality(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (!project?.latestVersionId) return;
  const version = await ctx.db.get(project.latestVersionId);
  const target = version
    ? extractHealthCheckTarget(parseSpec(version.spec))
    : null;
  await ctx.db.patch(projectId, {
    quality: {
      snapshot: null,
      recoveryPasses: 0,
      versionId: project.latestVersionId,
      probeTarget: target
        ? { url: target.url, method: target.method }
        : undefined,
      nextProbeAt: target ? Date.now() : undefined,
    },
  });
  await recompute(ctx, (await ctx.db.get(projectId))!);
}
export const recomputeGatewayQuality = internalMutation({
  args: { projectId: v.id("projects"), specVersionId: v.id("specVersions") },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.projectId);
    if (p?.latestVersionId === args.specVersionId) await recompute(ctx, p);
  },
});
export const runDueProbes = internalMutation({
  args: { cutoff: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = args.cutoff ?? Date.now();
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_probe", (q) =>
        q.gt("quality.nextProbeAt", 0).lte("quality.nextProbeAt", cutoff),
      )
      .take(20);
    for (const p of projects) {
      const org = await ctx.db.get(p.organizationId);
      if (
        !org ||
        !(await isActive(ctx, org)) ||
        p.retirement?.state === "retired" ||
        !p.quality.probeTarget
      ) {
        await ctx.db.patch(p._id, {
          quality: { ...p.quality, nextProbeAt: undefined },
        });
        continue;
      }
      const executionId = crypto.randomUUID(),
        leaseUntil = Date.now() + PROBE_LEASE_MS;
      await ctx.db.patch(p._id, {
        quality: {
          ...p.quality,
          leaseId: executionId,
          leaseUntil,
          nextProbeAt: leaseUntil,
        },
      });
      await ctx.scheduler.runAfter(
        0,
        internal.qualityProbeAction.runScheduledProbe,
        { targetId: p._id, executionId },
      );
    }
    if (projects.length === 20)
      await ctx.scheduler.runAfter(1000, internal.quality.runDueProbes, {
        cutoff,
      });
  },
});
export const getLeasedTarget = internalQuery({
  args: { targetId: v.id("projects"), executionId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.targetId),
      org = p && (await ctx.db.get(p.organizationId));
    return p &&
      org &&
      (await isActive(ctx, org)) &&
      p.retirement?.state !== "retired" &&
      p.quality.leaseId === args.executionId &&
      (p.quality.leaseUntil ?? 0) > Date.now() &&
      p.quality.versionId === p.latestVersionId
      ? (p.quality.probeTarget ?? null)
      : null;
  },
});
export const recordProbeResult = internalMutation({
  args: {
    targetId: v.id("projects"),
    executionId: v.string(),
    outcome,
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.targetId),
      org = p && (await ctx.db.get(p.organizationId));
    if (
      !p?.latestVersionId ||
      !org ||
      !(await isActive(ctx, org)) ||
      p.retirement?.state === "retired" ||
      p.quality.versionId !== p.latestVersionId ||
      p.quality.leaseId !== args.executionId ||
      (p.quality.leaseUntil ?? 0) < Date.now()
    )
      return { applied: false };
    if (
      await ctx.db
        .query("qualityEvents")
        .withIndex("by_execution", (q) => q.eq("executionId", args.executionId))
        .unique()
    )
      return { applied: false };
    await ctx.db.insert("qualityEvents", {
      kind: "probe",
      projectId: p._id,
      specVersionId: p.latestVersionId,
      generation: p.publicationGeneration,
      executionId: args.executionId,
      at: Date.now(),
      outcome: args.outcome,
      statusCode: args.statusCode,
      latencyMs: args.latencyMs,
    });
    const recent = await ctx.db
      .query("qualityEvents")
      .withIndex("by_version_kind_time", (q) =>
        q
          .eq("projectId", p._id)
          .eq("specVersionId", p.latestVersionId!)
          .eq("kind", "probe"),
      )
      .order("desc")
      .take(5);
    const failures = recent.filter(
      (r) => r.kind === "probe" && r.outcome !== "healthy",
    ).length;
    const incidents = await ctx.db
      .query("qualityEvents")
      .withIndex("by_project_kind_time", (q) =>
        q.eq("projectId", p._id).eq("kind", "incident"),
      )
      .order("desc")
      .take(1);
    const incident =
      incidents[0]?.kind === "incident" && incidents[0].state === "open"
        ? incidents[0]
        : null;
    let status = p.qualityStatus,
      passes = args.outcome === "healthy" ? p.quality.recoveryPasses + 1 : 0;
    if (status !== "active") {
      if (passes >= 3) {
        status = "active";
        if (incident)
          await ctx.db.patch(incident._id, {
            state: "closed",
            closedAt: Date.now(),
            recoveryPasses: passes,
          });
      } else status = passes ? "recovering" : "suspended";
    } else if (failures >= 3) {
      status = "suspended";
      passes = 0;
      await ctx.db.insert("qualityEvents", {
        kind: "incident",
        projectId: p._id,
        specVersionId: p.latestVersionId,
        at: Date.now(),
        state: "open",
        reason: "Three of the last five health checks failed",
        failureCount: failures,
        recoveryPasses: 0,
        lastOutcome: args.outcome,
      });
    }
    if (incident && status !== "active")
      await ctx.db.patch(incident._id, {
        recoveryPasses: passes,
        failureCount: failures,
        lastOutcome: args.outcome,
      });
    const visibility = status === "active" ? p.desiredVisibility : "private";
    await ctx.db.patch(p._id, {
      qualityStatus: status,
      visibility,
      discoverable:
        status === "active" &&
        visibility === "public" &&
        !p.retirement &&
        p.endpointCount > 0,
      revision: p.revision + Number(status !== p.qualityStatus),
      quality: {
        ...p.quality,
        recoveryPasses: status === "active" ? 0 : passes,
        leaseId: undefined,
        leaseUntil: undefined,
        nextProbeAt: Date.now() + PROBE_INTERVAL_MS,
      },
    });
    const after = (await ctx.db.get(p._id))!;
    await syncCatalogue(ctx, p, after);
    await recompute(ctx, after);
    if ((p.qualityStatus === "active") !== (status === "active"))
      await createNotification(ctx, {
        organizationId: p.organizationId,
        kind: status === "active" ? "quality_restored" : "quality_suspended",
        title:
          status === "active" ? `${p.name} restored` : `${p.name} suspended`,
        body:
          status === "active"
            ? "Three consecutive health checks passed."
            : "Three of the last five health checks failed. Fix the declared health endpoint to restore access.",
        refId: `quality:${p._id}:${args.executionId}`,
      });
    return { applied: true };
  },
});
export const getPublicSnapshot = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.projectId);
    return p && (await listing(ctx, p)) && p.quality.snapshot
      ? qualitySnapshotContract(p.quality.snapshot)
      : null;
  },
});
export const getPublisherQuality = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project: p } = await requireProjectMember(ctx, args.projectId),
      version = p.latestVersionId ? await ctx.db.get(p.latestVersionId) : null;
    const probes = p.latestVersionId
      ? await ctx.db
          .query("qualityEvents")
          .withIndex("by_version_kind_time", (q) =>
            q
              .eq("projectId", p._id)
              .eq("specVersionId", p.latestVersionId!)
              .eq("kind", "probe"),
          )
          .order("desc")
          .take(24)
      : [];
    const incident = await ctx.db
      .query("qualityEvents")
      .withIndex("by_project_kind_time", (q) =>
        q.eq("projectId", p._id).eq("kind", "incident"),
      )
      .order("desc")
      .first();
    return {
      version: version?.version ?? null,
      quality: p.quality.snapshot
        ? qualitySnapshotContract(p.quality.snapshot)
        : null,
      status: p.qualityStatus,
      suspensionReason:
        incident?.kind === "incident" && incident.state === "open"
          ? incident.reason
          : null,
      suspendedAt:
        incident?.kind === "incident" && incident.state === "open"
          ? incident.at
          : null,
      recoveryPasses: p.quality.recoveryPasses,
      recoveryRequired: 3,
      probeIntervalMs: PROBE_INTERVAL_MS,
      historyLimit: 24,
      probes: probes.flatMap((r) =>
        r.kind === "probe"
          ? [
              {
                id: r._id,
                checkedAt: r.at,
                outcome: r.outcome,
                statusCode: r.statusCode ?? null,
                latencyMs: r.latencyMs ?? null,
              },
            ]
          : [],
      ),
    };
  },
});
export const listPublicIncidents = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.projectId);
    if (!p || !(await listing(ctx, p)))
      return { page: [], isDone: true, continueCursor: "" };
    const rows = await ctx.db
      .query("qualityEvents")
      .withIndex("by_project_kind_time", (q) =>
        q.eq("projectId", p._id).eq("kind", "incident"),
      )
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(50, args.paginationOpts.numItems),
        maximumRowsRead: 51,
      });
    return {
      ...rows,
      page: await Promise.all(
        rows.page.flatMap((r) =>
          r.kind === "incident"
            ? [
                (async () => ({
                  id: r._id,
                  version:
                    (await ctx.db.get(r.specVersionId))?.version ?? "unknown",
                  openedAt: r.at,
                  closedAt: r.closedAt ?? null,
                  status:
                    r.state === "closed"
                      ? ("resolved" as const)
                      : ("open" as const),
                  lastOutcome: r.lastOutcome,
                  reason: r.reason,
                  failureCount: r.failureCount,
                  threshold: 3,
                  windowSize: 5,
                }))(),
              ]
            : [],
        ),
      ),
    };
  },
});
