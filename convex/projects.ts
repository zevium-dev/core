import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireOrgAdmin,
  requireOrgMemberBySlug,
  requireProjectMember,
} from "./lib/auth";
import {
  upsertNotification,
  upsertProjectRetirementConsumerNotice,
} from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import { isValidSlug } from "./lib/validate";
import { syncCatalogueListing } from "./catalogue";

export const MIN_DEPRECATION_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIREMENT_BATCH_SIZE = 100;
const RETIREMENT_REPAIR_BATCH_SIZE = 25;
const NOTICE_USAGE_PAGE_SIZE = 100;
const INLINE_CREDENTIAL_CLEANUP_SIZE = 10;
const CREDENTIAL_CLEANUP_PAGE_SIZE = 100;

async function cleanupProjectRuntime(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<void> {
  const draft = await ctx.db
    .query("specs")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (draft !== null) await ctx.db.delete(draft._id);

  const credentials = await ctx.db
    .query("upstreamCredentials")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(INLINE_CREDENTIAL_CLEANUP_SIZE);
  for (const credential of credentials) await ctx.db.delete(credential._id);
  if (credentials.length === INLINE_CREDENTIAL_CLEANUP_SIZE) {
    await ctx.scheduler.runAfter(
      0,
      internal.projects.deleteProjectCredentialsPage,
      { projectId },
    );
  }

  const readiness = await ctx.db
    .query("publishReadiness")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (readiness !== null) await ctx.db.delete(readiness._id);

  const embedding = await ctx.db
    .query("specEmbeddings")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (embedding !== null) await ctx.db.delete(embedding._id);

  const webhook = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
  if (webhook !== null) await ctx.db.patch(webhook._id, { active: false });
}

/** Drain legacy/high-cardinality credential sets without an unbounded mutation. */
export const deleteProjectCredentialsPage = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: number; done: boolean }> => {
    const credentials = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(CREDENTIAL_CLEANUP_PAGE_SIZE);
    for (const credential of credentials) await ctx.db.delete(credential._id);
    const done = credentials.length < CREDENTIAL_CLEANUP_PAGE_SIZE;
    if (!done) {
      await ctx.scheduler.runAfter(
        0,
        internal.projects.deleteProjectCredentialsPage,
        args,
      );
    }
    return { deleted: credentials.length, done };
  },
});

export const list = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<Doc<"projects">[]> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .collect();
    return projects.filter((project) => project.retiredAt === undefined);
  },
});

export const get = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"projects"> | null> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    return project?.retiredAt === undefined ? project : null;
  },
});

export const create = mutation({
  args: {
    orgSlug: v.string(),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new Error("Name is required");
    }
    if (name.length > 120) {
      throw new Error("Name must be at most 120 characters");
    }

    const slug = args.slug.trim().toLowerCase();
    if (!isValidSlug(slug)) {
      throw new Error(
        "Slug must be kebab-case (lowercase letters, numbers, hyphens)",
      );
    }

    const description =
      args.description === undefined ? undefined : args.description.trim();
    if (description !== undefined && description.length > 2000) {
      throw new Error("Description must be at most 2000 characters");
    }

    const existing = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", slug),
      )
      .unique();
    if (existing !== null) {
      throw new Error("Project slug already exists in this organization");
    }

    const projectId = await ctx.db.insert("projects", {
      organizationId: org._id,
      name,
      slug,
      description: description === "" ? undefined : description,
      status: "draft",
      visibility: "private",
      tags: [],
    });

    // Empty draft so editor always has a row.
    await ctx.db.insert("specs", {
      projectId,
      draft: "",
      lastSavedAt: Date.now(),
    });

    const created = await ctx.db.get(projectId);
    if (created === null) {
      throw new Error("Failed to load created project");
    }
    return created;
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.union(v.string(), v.null())),
      visibility: v.optional(
        v.union(v.literal("private"), v.literal("public")),
      ),
      tags: v.optional(v.array(v.string())),
    }),
  },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    await requireProjectMember(ctx, args.projectId);

    const current = await ctx.db.get(args.projectId);
    if (current === null) {
      throw new Error("Project not found");
    }
    if (current.retiredAt !== undefined) {
      throw new Error("Project is retired");
    }

    let name = current.name;
    let description = current.description;
    let visibility = current.visibility;
    let tags = current.tags;
    let descriptionCleared = false;

    if (args.patch.name !== undefined) {
      const next = args.patch.name.trim();
      if (next.length === 0) {
        throw new Error("Name is required");
      }
      if (next.length > 120) {
        throw new Error("Name must be at most 120 characters");
      }
      name = next;
    }

    if (args.patch.description !== undefined) {
      if (args.patch.description === null) {
        description = undefined;
        descriptionCleared = true;
      } else {
        const next = args.patch.description.trim();
        if (next.length > 2000) {
          throw new Error("Description must be at most 2000 characters");
        }
        description = next === "" ? undefined : next;
        descriptionCleared = next === "";
      }
    }

    if (args.patch.visibility !== undefined) {
      if (
        current.status === "published" &&
        current.visibility === "public" &&
        args.patch.visibility === "private"
      ) {
        throw new Error(
          "Published projects require a deprecation notice before unpublishing",
        );
      }
      visibility = args.patch.visibility;
    }

    if (args.patch.tags !== undefined) {
      const raw = args.patch.tags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      const seen: Record<string, true> = {};
      const unique: string[] = [];
      for (const tag of raw) {
        if (seen[tag]) continue;
        seen[tag] = true;
        unique.push(tag);
      }
      if (unique.length > 32) {
        throw new Error("At most 32 tags");
      }
      tags = unique;
    }

    if (descriptionCleared) {
      // Optional field clear needs replace — patch cannot unset.
      await ctx.db.replace(args.projectId, {
        organizationId: current.organizationId,
        name,
        slug: current.slug,
        description: undefined,
        status: current.status,
        visibility,
        tags,
        deprecationStartedAt: current.deprecationStartedAt,
        sunsetAt: current.sunsetAt,
        deprecationMessage: current.deprecationMessage,
        retirementState: current.retirementState,
        retirementRevision: current.retirementRevision,
        retirementCutoffAt: current.retirementCutoffAt,
        retiredAt: current.retiredAt,
      });
    } else {
      await ctx.db.patch(args.projectId, {
        name,
        description,
        visibility,
        tags,
      });
    }

    const updated = await ctx.db.get(args.projectId);
    if (updated === null) {
      throw new Error("Failed to load updated project");
    }
    await syncCatalogueListing(ctx, updated._id);
    return updated;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ deleted: Id<"projects"> }> => {
    const { claims, project } = await requireProjectMember(ctx, args.projectId);
    requireOrgAdmin(claims);

    if (project.status === "published") {
      if (project.sunsetAt === undefined) {
        throw new Error(
          "Schedule deprecation before deleting a published project",
        );
      }
      if (Date.now() < project.sunsetAt) {
        throw new Error("Published project cannot be deleted before sunset");
      }
    }

    await cleanupProjectRuntime(ctx, args.projectId);

    if (project.status === "draft") {
      await ctx.db.delete(args.projectId);
    } else {
      await ctx.db.patch(args.projectId, {
        visibility: "private",
        retirementState: "retired",
        retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
        sunsetAt: undefined,
        retiredAt: Date.now(),
      });
    }
    await syncCatalogueListing(ctx, args.projectId);
    return { deleted: args.projectId };
  },
});

export const scheduleRetirement = mutation({
  args: {
    projectId: v.id("projects"),
    sunsetAt: v.number(),
    message: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    const { claims, org, project } = await requireProjectMember(
      ctx,
      args.projectId,
    );
    requireOrgAdmin(claims);
    if (project.status !== "published" || project.visibility !== "public") {
      throw new Error("Only public published projects can be deprecated");
    }
    if (project.retiredAt !== undefined) throw new Error("Project is retired");
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.sunsetAt) ||
      !Number.isFinite(new Date(args.sunsetAt).getTime()) ||
      args.sunsetAt < now + MIN_DEPRECATION_NOTICE_MS
    ) {
      throw new Error("Sunset must provide at least 7 days notice");
    }
    const message = args.message.trim();
    if (message.length === 0 || message.length > 1000) {
      throw new Error("Deprecation message must be 1-1000 characters");
    }
    if (
      project.retirementState === "scheduled" &&
      project.sunsetAt === args.sunsetAt &&
      project.deprecationMessage === message
    ) {
      return project;
    }
    const deprecationStartedAt = project.deprecationStartedAt ?? now;
    const retirementRevision = (project.retirementRevision ?? 0) + 1;
    if (!Number.isSafeInteger(retirementRevision)) {
      throw new Error("Project retirement revision exhausted");
    }
    await ctx.db.patch(project._id, {
      deprecationStartedAt,
      sunsetAt: args.sunsetAt,
      deprecationMessage: message,
      retirementState: "scheduled",
      retirementRevision,
    });
    await upsertNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "project_retirement",
      title: "Project retirement scheduled",
      body: `${project.name} will sunset ${new Date(args.sunsetAt).toISOString()}. ${message}`,
      refId: `project_retirement:${project._id}:publisher`,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.projects.notifyRetirementConsumersPage,
      {
        projectId: project._id,
        retirementRevision,
        sunsetAt: args.sunsetAt,
        event: "scheduled",
        cursor: null,
      },
    );
    await fireWebhookEvent(ctx, project._id, "project.deprecated", {
      projectId: project._id,
      sunsetAt: args.sunsetAt,
      message,
    });
    const updated = await ctx.db.get(project._id);
    if (updated === null) throw new Error("Project not found");
    await syncCatalogueListing(ctx, project._id);
    return updated;
  },
});

export const cancelRetirement = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    const { claims, org, project } = await requireProjectMember(
      ctx,
      args.projectId,
    );
    requireOrgAdmin(claims);
    if (project.retiredAt !== undefined) {
      throw new Error("Retired projects cannot be restored");
    }
    if (project.sunsetAt !== undefined && project.sunsetAt <= Date.now()) {
      throw new Error("Retirement cannot be canceled after sunset");
    }
    if (
      project.sunsetAt === undefined ||
      project.deprecationStartedAt === undefined
    ) {
      throw new Error("Project has no scheduled retirement");
    }
    const retirementRevision = (project.retirementRevision ?? 0) + 1;
    if (!Number.isSafeInteger(retirementRevision)) {
      throw new Error("Project retirement revision exhausted");
    }
    const canceledSunsetAt = project.sunsetAt;
    await ctx.db.replace(project._id, {
      organizationId: project.organizationId,
      name: project.name,
      slug: project.slug,
      description: project.description,
      status: project.status,
      visibility: project.visibility,
      tags: project.tags,
      retirementRevision,
    });
    await upsertNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "project_retirement",
      title: "Project retirement canceled",
      body: `${project.name} will remain available.`,
      refId: `project_retirement:${project._id}:publisher`,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.projects.notifyRetirementConsumersPage,
      {
        projectId: project._id,
        retirementRevision,
        sunsetAt: canceledSunsetAt,
        event: "canceled",
        cursor: null,
      },
    );
    await fireWebhookEvent(ctx, project._id, "project.deprecation_canceled", {
      projectId: project._id,
      canceledSunsetAt,
    });
    const updated = await ctx.db.get(project._id);
    if (updated === null) throw new Error("Project not found");
    await syncCatalogueListing(ctx, project._id);
    return updated;
  },
});

/**
 * Notify every consumer org that has called this project. The indexed usage
 * scan is paginated, each org/ref pair is idempotent, and stale reschedule jobs
 * exit before producing side effects.
 */
export const notifyRetirementConsumersPage = internalMutation({
  args: {
    projectId: v.id("projects"),
    retirementRevision: v.number(),
    sunsetAt: v.number(),
    event: v.union(v.literal("scheduled"), v.literal("canceled")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; notified: number; done: boolean }> => {
    const project = await ctx.db.get(args.projectId);
    const current =
      project !== null &&
      project.retirementRevision === args.retirementRevision &&
      project.retiredAt === undefined &&
      (args.event === "scheduled"
        ? project.retirementState === "scheduled" &&
          project.sunsetAt === args.sunsetAt
        : project.retirementState === undefined &&
          project.sunsetAt === undefined);
    if (!current || project === null) {
      return { scanned: 0, notified: 0, done: true };
    }
    const publisher = await ctx.db.get(project.organizationId);
    if (publisher === null || publisher.archivedAt !== undefined) {
      return { scanned: 0, notified: 0, done: true };
    }

    const page = await ctx.db
      .query("usageEvents")
      .withIndex("by_project_at", (q) => q.eq("projectId", project._id))
      .order("asc")
      .paginate({ cursor: args.cursor, numItems: NOTICE_USAGE_PAGE_SIZE });
    const consumerIds = [
      ...new Set(page.page.map((event) => event.organizationId)),
    ];
    let notified = 0;
    for (const organizationId of consumerIds) {
      if (organizationId === project.organizationId) continue;
      const consumer = await ctx.db.get(organizationId);
      if (consumer === null || consumer.archivedAt !== undefined) continue;
      await upsertProjectRetirementConsumerNotice(ctx, {
        consumerClerkOrgId: consumer.clerkOrgId,
        projectId: project._id,
        projectName: project.name,
        projectSlug: project.slug,
        publisherName: publisher.name,
        publisherHandle: publisher.publicHandle,
        sunsetAt: args.sunsetAt,
        message: project.deprecationMessage,
        event: args.event,
      });
      notified += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.projects.notifyRetirementConsumersPage,
        { ...args, cursor: page.continueCursor },
      );
    }
    return { scanned: page.page.length, notified, done: page.isDone };
  },
});

/**
 * Close the async-settlement race with paginated fanout. A usage event that
 * lands behind an existing cursor gets this independent canonical upsert.
 */
export const reconcileRetirementConsumerNotice = internalMutation({
  args: {
    projectId: v.id("projects"),
    consumerOrganizationId: v.id("organizations"),
  },
  handler: async (ctx, args): Promise<{ notified: boolean }> => {
    const [project, consumer] = await Promise.all([
      ctx.db.get(args.projectId),
      ctx.db.get(args.consumerOrganizationId),
    ]);
    if (
      project === null ||
      consumer === null ||
      consumer.archivedAt !== undefined ||
      project.organizationId === consumer._id ||
      project.retirementState !== "scheduled" ||
      project.sunsetAt === undefined ||
      project.retiredAt !== undefined
    ) {
      return { notified: false };
    }
    const publisher = await ctx.db.get(project.organizationId);
    if (publisher === null || publisher.archivedAt !== undefined) {
      return { notified: false };
    }
    await upsertProjectRetirementConsumerNotice(ctx, {
      consumerClerkOrgId: consumer.clerkOrgId,
      projectId: project._id,
      projectName: project.name,
      projectSlug: project.slug,
      publisherName: publisher.name,
      publisherHandle: publisher.publicHandle,
      sunsetAt: project.sunsetAt,
      message: project.deprecationMessage,
      event: "scheduled",
    });
    return { notified: true };
  },
});

/** Hourly bounded sunset cleanup. Immutable versions and usage history remain. */
export const retireSunsetProjects = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ retired: number; hasMore: boolean }> => {
    const now = Date.now();
    // Optional-first schema permits malformed legacy rows. Repair them on a
    // separate bounded range so missing sunsetAt values can never pin due work.
    const malformed = await ctx.db
      .query("projects")
      .withIndex("by_retirement_state_sunset", (q) =>
        q.eq("retirementState", "scheduled").eq("sunsetAt", undefined),
      )
      .take(RETIREMENT_REPAIR_BATCH_SIZE);
    for (const project of malformed) {
      await ctx.db.patch(project._id, {
        deprecationStartedAt: undefined,
        deprecationMessage: undefined,
        retirementState: undefined,
      });
      await syncCatalogueListing(ctx, project._id);
    }
    const candidates = await ctx.db
      .query("projects")
      .withIndex("by_retirement_state_sunset", (q) =>
        q
          .eq("retirementState", "scheduled")
          .gt("sunsetAt", 0)
          .lte("sunsetAt", now),
      )
      .take(RETIREMENT_BATCH_SIZE);
    let retired = 0;
    for (const project of candidates) {
      if (project.sunsetAt === undefined) {
        continue;
      }
      if (project.retiredAt !== undefined) {
        await ctx.db.patch(project._id, {
          retirementState: "retired",
          retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
          sunsetAt: undefined,
        });
        await syncCatalogueListing(ctx, project._id);
        continue;
      }
      if (project.deprecationStartedAt === undefined) {
        await ctx.db.patch(project._id, {
          retirementState: undefined,
          retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
          sunsetAt: undefined,
        });
        await syncCatalogueListing(ctx, project._id);
        continue;
      }
      await cleanupProjectRuntime(ctx, project._id);
      await ctx.db.patch(project._id, {
        visibility: "private",
        retirementState: "retired",
        retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
        sunsetAt: undefined,
        retiredAt: now,
      });
      await syncCatalogueListing(ctx, project._id);
      retired += 1;
    }
    // Transitional drain for rows written before retirementState existed.
    // Every visited legacy row leaves by_sunset, so even 100+ old tombstones
    // cannot pin the head of the queue forever.
    const remaining = RETIREMENT_BATCH_SIZE - candidates.length;
    const legacyCandidates =
      remaining > 0
        ? await ctx.db
            .query("projects")
            .withIndex("by_sunset", (q) =>
              q.gt("sunsetAt", 0).lte("sunsetAt", now),
            )
            .take(remaining)
        : [];
    for (const project of legacyCandidates) {
      if (project.retirementState === "scheduled") continue;
      if (
        project.retiredAt === undefined &&
        project.deprecationStartedAt !== undefined
      ) {
        await cleanupProjectRuntime(ctx, project._id);
        await ctx.db.patch(project._id, {
          visibility: "private",
          retirementState: "retired",
          retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
          sunsetAt: undefined,
          retiredAt: now,
        });
        await syncCatalogueListing(ctx, project._id);
        retired += 1;
      } else {
        await ctx.db.patch(project._id, {
          retirementState:
            project.retiredAt === undefined ? undefined : "retired",
          retirementCutoffAt: project.retirementCutoffAt ?? project.sunsetAt,
          sunsetAt: undefined,
        });
        await syncCatalogueListing(ctx, project._id);
      }
    }
    const processed = candidates.length + legacyCandidates.length;
    const hasMore =
      processed === RETIREMENT_BATCH_SIZE ||
      malformed.length === RETIREMENT_REPAIR_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.projects.retireSunsetProjects,
        {},
      );
    }
    return { retired, hasMore };
  },
});
