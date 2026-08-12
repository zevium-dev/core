import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import {
  enqueueOrgArchive,
  enqueueKeyState,
  enqueueRouteArchive,
} from "./registrySync";

const PAGE_SIZE = 50;
const KEY_PAGE_SIZE = 25;
const RECOVERY_WINDOW_MS = 60_000;
const MAX_FAILURE_ATTEMPTS = 8;

async function existingJob(ctx: MutationCtx, resourceKey: string) {
  return await ctx.db
    .query("retirementJobs")
    .withIndex("by_resource", (q) => q.eq("resourceKey", resourceKey))
    .unique();
}

async function resumeFailedJob(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
): Promise<void> {
  if (job.status !== "failed") return;
  const now = Date.now();
  await ctx.db.patch(job._id, {
    status: "pending",
    failureAttempts: 0,
    lastError: undefined,
    nextRunAt: now + RECOVERY_WINDOW_MS,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.retirementJobs.run, {
    jobId: job._id,
  });
}

async function createJob(
  ctx: MutationCtx,
  args: {
    resourceKey: string;
    kind: Doc<"retirementJobs">["kind"];
    resourceId: string;
    phase: string;
  },
): Promise<Id<"retirementJobs">> {
  const prior = await existingJob(ctx, args.resourceKey);
  if (prior !== null) {
    await resumeFailedJob(ctx, prior);
    return prior._id;
  }
  const now = Date.now();
  const jobId = await ctx.db.insert("retirementJobs", {
    ...args,
    status: "pending",
    attempts: 0,
    failureAttempts: 0,
    nextRunAt: now + RECOVERY_WINDOW_MS,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.retirementJobs.run, { jobId });
  return jobId;
}

/** Archive first, then tombstone. Cleanup happens outside caller transaction. */
export async function beginProjectRetirement(
  ctx: MutationCtx,
  project: Doc<"projects">,
  org: Doc<"organizations">,
): Promise<Id<"retirementJobs">> {
  const resourceKey = `project:${project._id}`;
  const prior = await existingJob(ctx, resourceKey);
  if (prior !== null) {
    await resumeFailedJob(ctx, prior);
    return prior._id;
  }
  if (project.status === "published") {
    await enqueueRouteArchive(ctx, project, org);
  }
  const now = Date.now();
  await ctx.db.patch(project._id, { retiringAt: project.retiringAt ?? now });
  const endpoint = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .unique();
  if (endpoint !== null) {
    await ctx.db.patch(endpoint._id, {
      active: false,
      retiringAt: endpoint.retiringAt ?? now,
    });
  }
  return await createJob(ctx, {
    resourceKey,
    kind: "project",
    resourceId: project._id,
    phase: "versions",
  });
}

/** Stop secret use atomically; delivery log deletion continues in pages. */
export async function beginWebhookRetirement(
  ctx: MutationCtx,
  endpoint: Doc<"webhookEndpoints">,
): Promise<Id<"retirementJobs">> {
  const resourceKey = `webhook:${endpoint._id}`;
  const prior = await existingJob(ctx, resourceKey);
  if (prior !== null) {
    await resumeFailedJob(ctx, prior);
    return prior._id;
  }
  const now = Date.now();
  await ctx.db.patch(endpoint._id, {
    active: false,
    retiringAt: endpoint.retiringAt ?? now,
  });
  return await createJob(ctx, {
    resourceKey,
    kind: "webhook",
    resourceId: endpoint._id,
    phase: "deliveries",
  });
}

/** Org tombstone closes every published route before child cleanup starts. */
export async function beginOrganizationRetirement(
  ctx: MutationCtx,
  org: Doc<"organizations">,
): Promise<Id<"retirementJobs">> {
  const resourceKey = `organization:${org._id}`;
  const prior = await existingJob(ctx, resourceKey);
  if (prior !== null) {
    await resumeFailedJob(ctx, prior);
    return prior._id;
  }
  await enqueueOrgArchive(ctx, org);
  await ctx.db.patch(org._id, { retiringAt: org.retiringAt ?? Date.now() });
  return await createJob(ctx, {
    resourceKey,
    kind: "organization",
    resourceId: org._id,
    phase: "projects",
  });
}

async function queueNext(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
  phase: string = job.phase,
  delayMs = 0,
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(job._id, {
    phase,
    status: "pending",
    attempts: job.attempts + 1,
    failureAttempts: 0,
    lastError: undefined,
    nextRunAt: now + RECOVERY_WINDOW_MS,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(delayMs, internal.retirementJobs.run, {
    jobId: job._id,
  });
}

async function completeJob(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(job._id, {
    status: "completed",
    attempts: job.attempts + 1,
    failureAttempts: 0,
    nextRunAt: now,
    updatedAt: now,
    completedAt: now,
  });
}

async function stepProject(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
): Promise<void> {
  const projectId = job.resourceId as Id<"projects">;
  const project = await ctx.db.get(projectId);
  if (project === null) return await completeJob(ctx, job);

  if (job.phase === "versions") {
    const rows = await ctx.db
      .query("specVersions")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(
      ctx,
      job,
      rows.length === 0 ? "credentials" : job.phase,
    );
  }
  if (job.phase === "credentials") {
    const rows = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(
      ctx,
      job,
      rows.length === 0 ? "embeddings" : job.phase,
    );
  }
  if (job.phase === "embeddings") {
    const rows = await ctx.db
      .query("specEmbeddings")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(ctx, job, rows.length === 0 ? "webhook" : job.phase);
  }
  if (job.phase === "webhook") {
    const endpoint = await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    if (endpoint === null) return await queueNext(ctx, job, "final");
    if (endpoint.active || endpoint.retiringAt === undefined) {
      await ctx.db.patch(endpoint._id, {
        active: false,
        retiringAt: endpoint.retiringAt ?? Date.now(),
      });
    }
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_endpoint", (q) => q.eq("endpointId", endpoint._id))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) return await queueNext(ctx, job);
    await ctx.db.delete(endpoint._id);
    return await queueNext(ctx, job, "final");
  }
  if (job.phase !== "final")
    throw new Error("Unknown project retirement phase");
  const draft = await ctx.db
    .query("specs")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (draft !== null) await ctx.db.delete(draft._id);
  const readiness = await ctx.db
    .query("publishReadiness")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (readiness !== null) await ctx.db.delete(readiness._id);
  await ctx.db.delete(projectId);
  await completeJob(ctx, job);
}

async function stepWebhook(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
): Promise<void> {
  const endpointId = job.resourceId as Id<"webhookEndpoints">;
  const endpoint = await ctx.db.get(endpointId);
  if (endpoint === null) return await completeJob(ctx, job);
  await ctx.db.patch(endpointId, {
    active: false,
    retiringAt: endpoint.retiringAt ?? Date.now(),
  });
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_endpoint", (q) => q.eq("endpointId", endpointId))
    .take(PAGE_SIZE);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length > 0) return await queueNext(ctx, job);
  await ctx.db.delete(endpointId);
  await completeJob(ctx, job);
}

async function stepOrganization(
  ctx: MutationCtx,
  job: Doc<"retirementJobs">,
): Promise<void> {
  const organizationId = job.resourceId as Id<"organizations">;
  const org = await ctx.db.get(organizationId);
  if (org === null) return await completeJob(ctx, job);

  if (job.phase === "projects") {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .first();
    if (project !== null) {
      await beginProjectRetirement(ctx, project, org);
      return await queueNext(ctx, job, job.phase, 1_000);
    }
    return await queueNext(ctx, job, "keys");
  }
  if (job.phase === "keys") {
    const rows = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .take(KEY_PAGE_SIZE);
    const owners = new Set<string>();
    for (const row of rows) {
      if (row.ownerUserId !== undefined) owners.add(row.ownerUserId);
      await ctx.db.patch(row._id, {
        disabled: true,
        graceUntil: undefined,
        membershipRevokedAt: Date.now(),
        updatedAt: Date.now(),
      });
      const disabled = await ctx.db.get(row._id);
      if (disabled !== null) await enqueueKeyState(ctx, disabled, "revoked");
      await ctx.db.delete(row._id);
    }
    for (const userId of owners) {
      await ctx.scheduler.runAfter(0, internal.keyBroker.revokeMembershipKeys, {
        clerkOrgId: org.clerkOrgId,
        userId,
      });
    }
    return await queueNext(
      ctx,
      job,
      rows.length === 0 ? "rotations" : job.phase,
    );
  }
  if (job.phase === "rotations") {
    const rows = await ctx.db
      .query("keyRotationOperations")
      .withIndex("by_operation", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(
      ctx,
      job,
      rows.length === 0 ? "key-lifecycle" : job.phase,
    );
  }
  if (job.phase === "key-lifecycle") {
    const rows = await ctx.db
      .query("keyLifecycleOperations")
      .withIndex("by_operation", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(
      ctx,
      job,
      rows.length === 0 ? "membership" : job.phase,
    );
  }
  if (job.phase === "membership") {
    const rows = await ctx.db
      .query("clerkMembershipStates")
      .withIndex("by_membership", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return await queueNext(ctx, job, rows.length === 0 ? "wallet" : job.phase);
  }
  if (job.phase === "wallet") {
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organizationId),
      )
      .unique();
    if (wallet === null) return await queueNext(ctx, job, "final");
    const rows = await ctx.db
      .query("walletEntries")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .take(PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) return await queueNext(ctx, job);
    await ctx.db.delete(wallet._id);
    return await queueNext(ctx, job, "final");
  }
  if (job.phase !== "final") {
    throw new Error("Unknown organization retirement phase");
  }
  await ctx.db.delete(organizationId);
  await completeJob(ctx, job);
}

export const step = internalMutation({
  args: { jobId: v.id("retirementJobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "pending") return;
    if (job.kind === "project") return await stepProject(ctx, job);
    if (job.kind === "webhook") return await stepWebhook(ctx, job);
    await stepOrganization(ctx, job);
  },
});

export const recordFailure = internalMutation({
  args: { jobId: v.id("retirementJobs"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status === "completed") return;
    const failures = (job.failureAttempts ?? 0) + 1;
    const terminal = failures >= MAX_FAILURE_ATTEMPTS;
    const delay = Math.min(60 * 60_000, 2 ** failures * 30_000);
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: terminal ? "failed" : "pending",
      failureAttempts: failures,
      lastError: args.message.slice(0, 320),
      nextRunAt: now + delay,
      updatedAt: now,
    });
    if (!terminal) {
      await ctx.scheduler.runAfter(delay, internal.retirementJobs.run, {
        jobId: job._id,
      });
    }
  },
});

export const run = internalAction({
  args: { jobId: v.id("retirementJobs") },
  handler: async (ctx, args): Promise<void> => {
    try {
      await ctx.runMutation(internal.retirementJobs.step, args);
    } catch (error) {
      await ctx.runMutation(internal.retirementJobs.recordFailure, {
        ...args,
        message: error instanceof Error ? error.message : "Retirement failed",
      });
    }
  },
});

/** Recovery sweep covers lost scheduler messages without scanning whole table. */
export const scheduleDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query("retirementJobs")
      .withIndex("by_due", (q) =>
        q.eq("status", "pending").lte("nextRunAt", now),
      )
      .take(20);
    for (const job of due) {
      await ctx.db.patch(job._id, {
        nextRunAt: now + RECOVERY_WINDOW_MS,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.retirementJobs.run, {
        jobId: job._id,
      });
    }
    return { scheduled: due.length };
  },
});

/** Explicit operator resume after terminal retry exhaustion. */
export const resume = internalMutation({
  args: { jobId: v.id("retirementJobs") },
  handler: async (ctx, args): Promise<boolean> => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "failed") return false;
    await resumeFailedJob(ctx, job);
    return true;
  },
});
