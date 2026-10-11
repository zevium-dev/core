import { retirementNotice } from "./lifecycleNotices";
import { fireWebhookEvent } from "./webhooks";
import { syncCatalogue, adjustStat } from "./lib/catalogue";
import { paginationOptsValidator } from "convex/server";
import { v, ConvexError } from "convex/values";
import { isValidSlug, sha256Hex } from "@zevium/shared";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireActiveOrg,
  requireOrgAdmin,
  requireProjectMember,
  requireProjectAdmin,
} from "./lib/auth";
import { projectDto } from "./lib/dto";
export const MIN_DEPRECATION_NOTICE_MS = 7 * 86_400_000;
function bounded(value: string, max: number, label: string) {
  const text = value.trim();
  if (!text || text.length > max)
    throw new ConvexError(`${label} must be 1–${max} characters`);
  return text;
}
export const list = query({
  args: { orgSlug: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { org } = await requireActiveOrg(ctx);
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) => q.eq("organizationId", org._id))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)),
      });
    return {
      ...rows,
      page: rows.page
        .filter((r) => r.retirement?.state !== "retired")
        .map(projectDto),
    };
  },
});
export const get = query({
  args: { orgSlug: v.string(), projectSlug: v.string() },
  handler: async (ctx, args) => {
    const { org } = await requireActiveOrg(ctx);
    const row = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    return row && row.retirement?.state !== "retired" ? projectDto(row) : null;
  },
});
export const create = mutation({
  args: {
    orgSlug: v.string(),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { org, claims } = await requireActiveOrg(ctx);
    requireOrgAdmin(claims);
    const name = bounded(args.name, 120, "Name"),
      slug = args.slug.trim().toLowerCase();
    if (!isValidSlug(slug) || slug.length > 120)
      throw new ConvexError("Slug must be kebab-case");
    if ((args.description?.length ?? 0) > 2000)
      throw new ConvexError("Description must be at most 2000 characters");
    if (
      await ctx.db
        .query("projects")
        .withIndex("by_org_slug", (q) =>
          q.eq("organizationId", org._id).eq("slug", slug),
        )
        .unique()
    )
      throw new ConvexError("Project slug already exists in this organization");
    if (
      await ctx.db
        .query("routeTombstones")
        .withIndex("by_route", (q) =>
          q.eq("publisherHandle", org.publicHandle).eq("projectSlug", slug),
        )
        .unique()
    )
      throw new ConvexError("Project slug is permanently reserved");
    const draft = {
      hash: await sha256Hex(""),
      revision: 1,
      savedAt: Date.now(),
    };
    const id = await ctx.db.insert("projects", {
      organizationId: org._id,
      name,
      slug,
      description: args.description?.trim() || undefined,
      tags: [],
      status: "draft",
      visibility: "private",
      desiredVisibility: "private",
      qualityStatus: "active",
      revision: 1,
      publicationGeneration: 0,
      houseOperated: false,
      discoverable: false,
      searchText: name.toLowerCase(),
      sortName: name.toLowerCase(),
      endpointCount: 0,
      hasFreeTier: false,
      draft,
      quality: { snapshot: null, recoveryPasses: 0 },
      reviewSummary: {
        count: 0,
        ratingSum: 0,
        distribution: { one: 0, two: 0, three: 0, four: 0, five: 0 },
      },
    });
    await adjustStat(ctx, "draft", id, 1);
    await ctx.db.insert("projectDrafts", { projectId: id, text: "", ...draft });
    return projectDto((await ctx.db.get(id))!);
  },
});
export const update = mutation({
  args: {
    projectId: v.id("projects"),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.union(v.string(), v.null())),
      tags: v.optional(v.array(v.string())),
      visibility: v.optional(
        v.union(v.literal("private"), v.literal("public")),
      ),
    }),
  },
  handler: async (ctx, args) => {
    const { project, claims } = await requireProjectMember(ctx, args.projectId);
    if (project.status === "published" || args.patch.visibility !== undefined)
      requireOrgAdmin(claims);
    const patch: Partial<Doc<"projects">> = {};
    if (args.patch.name !== undefined) {
      patch.name = bounded(args.patch.name, 120, "Name");
      patch.sortName = patch.name.toLowerCase();
    }
    if (args.patch.description !== undefined) {
      if ((args.patch.description?.length ?? 0) > 2000)
        throw new ConvexError("Description must be at most 2000 characters");
      patch.description = args.patch.description?.trim() || undefined;
    }
    if (args.patch.tags !== undefined) {
      patch.tags = [
        ...new Set(
          args.patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
        ),
      ];
      if (patch.tags.length > 32 || patch.tags.some((t) => t.length > 80))
        throw new ConvexError("At most 32 tags of 80 characters");
    }
    if (args.patch.visibility !== undefined) {
      if (
        project.status === "published" &&
        project.desiredVisibility === "public" &&
        args.patch.visibility === "private"
      )
        throw new ConvexError(
          "Schedule project retirement before removing a published API from discovery",
        );
      patch.desiredVisibility = args.patch.visibility;
      // Publisher edits cannot lift a quality suspension.
      patch.visibility =
        project.qualityStatus === "active" ? args.patch.visibility : "private";
    }
    const visibility = patch.visibility ?? project.visibility;
    patch.discoverable =
      project.status === "published" &&
      visibility === "public" &&
      project.qualityStatus === "active" &&
      !project.retirement;
    patch.searchText = [
      patch.name ?? project.name,
      "description" in patch ? patch.description : project.description,
      ...(patch.tags ?? project.tags),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    patch.revision = project.revision + 1;
    await ctx.db.patch(project._id, patch);
    const after = (await ctx.db.get(project._id))!;
    await syncCatalogue(ctx, project, after);
    if (project.visibility !== after.visibility)
      await fireWebhookEvent(ctx, project._id, "project.visibility_changed", {
        projectId: project._id,
        visibility: after.visibility,
      });
    await retirementNotice(ctx, project, after);
    return projectDto(after);
  },
});
async function retireProject(ctx: MutationCtx, project: Doc<"projects">) {
  if (project.retirement?.state === "retired") return;
  const now = Date.now();
  const routes = await ctx.db
    .query("routeTombstones")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .collect();
  for (const route of routes)
    if (route.retiredAt === undefined)
      await ctx.db.patch(route._id, {
        retiredAt: now,
        revision: route.revision + 1,
      });
  // Runtime secrets go; immutable versions, finance, quality evidence and reserved routes stay.
  const credentials = await ctx.db
    .query("upstreamCredentials")
    .withIndex("by_project_name", (q) => q.eq("projectId", project._id))
    .collect();
  for (const credential of credentials) await ctx.db.delete(credential._id);
  await ctx.db.patch(project._id, {
    discoverable: false,
    visibility: "private",
    revision: project.revision + 1,
    webhook: undefined,
    draft: project.draft
      ? { ...project.draft, readiness: undefined }
      : undefined,
    quality: {
      ...project.quality,
      nextProbeAt: undefined,
      leaseId: undefined,
      leaseUntil: undefined,
    },
    retirement: {
      state: "retired",
      revision: (project.retirement?.revision ?? 0) + 1,
      message: project.retirement?.message ?? "Project archived",
      startedAt: project.retirement?.startedAt ?? now,
      sunsetAt: project.retirement?.sunsetAt ?? now,
      retiredAt: now,
      cleanupPhase: "complete",
    },
  });
  const after = (await ctx.db.get(project._id))!;
  await syncCatalogue(ctx, project, after);
  if (project.status === "published")
    await retirementNotice(ctx, project, after);
}
export const retire = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project) await retireProject(ctx, project);
  },
});
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    if (
      project.status === "published" &&
      (!project.retirement || project.retirement.sunsetAt > Date.now())
    )
      throw new ConvexError(
        "Schedule project retirement before removing a published API",
      );
    await retireProject(ctx, project);
    return { deleted: project._id, deletionState: "tombstoned" as const };
  },
});
export const scheduleRetirement = mutation({
  args: {
    projectId: v.id("projects"),
    sunsetAt: v.number(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    const message = bounded(args.message, 1000, "Message");
    if (
      project.retirement?.state === "scheduled" &&
      project.retirement.sunsetAt === args.sunsetAt &&
      project.retirement.message === message
    )
      return projectDto(project);
    if (
      project.status !== "published" ||
      project.desiredVisibility !== "public" ||
      !Number.isSafeInteger(args.sunsetAt) ||
      args.sunsetAt < Date.now() + MIN_DEPRECATION_NOTICE_MS
    )
      throw new ConvexError("Sunset must allow at least seven days of notice");
    if (project.retirement && project.retirement.sunsetAt <= Date.now())
      throw new ConvexError("Project retirement is terminal");
    const revision = (project.retirement?.revision ?? project.revision) + 1;
    await ctx.db.patch(project._id, {
      revision: project.revision + 1,
      discoverable: false,
      retirement: {
        state: "scheduled",
        revision,
        message,
        startedAt: Date.now(),
        sunsetAt: args.sunsetAt,
        cleanupPhase: "pending",
      },
    });
    await ctx.scheduler.runAt(
      args.sunsetAt,
      internal.projects.retireScheduled,
      { projectId: project._id, revision },
    );
    const after = (await ctx.db.get(project._id))!;
    await syncCatalogue(ctx, project, after);
    if (project.visibility !== after.visibility)
      await fireWebhookEvent(ctx, project._id, "project.visibility_changed", {
        projectId: project._id,
        visibility: after.visibility,
      });
    await retirementNotice(ctx, project, after);
    return projectDto(after);
  },
});
export const cancelRetirement = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAdmin(ctx, args.projectId);
    if (!project.retirement) return projectDto(project);
    if (project.retirement.sunsetAt <= Date.now())
      throw new ConvexError("Project retirement is terminal");
    await ctx.db.patch(project._id, {
      retirement: undefined,
      revision: Math.max(project.revision, project.retirement.revision) + 1,
      discoverable:
        project.status === "published" &&
        project.visibility === "public" &&
        project.qualityStatus === "active",
    });
    const after = (await ctx.db.get(project._id))!;
    await syncCatalogue(ctx, project, after);
    if (project.visibility !== after.visibility)
      await fireWebhookEvent(ctx, project._id, "project.visibility_changed", {
        projectId: project._id,
        visibility: after.visibility,
      });
    await retirementNotice(ctx, project, after);
    return projectDto(after);
  },
});
export const retireScheduled = internalMutation({
  args: { projectId: v.id("projects"), revision: v.number() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (
      project?.retirement?.state === "scheduled" &&
      project.retirement.revision === args.revision &&
      project.retirement.sunsetAt <= Date.now()
    )
      await retireProject(ctx, project);
  },
});
export const retireSunsetProjects = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("projects")
      .withIndex("by_retire", (q) =>
        q
          .eq("retirement.state", "scheduled")
          .lte("retirement.sunsetAt", Date.now()),
      )
      .take(50);
    for (const project of due) await retireProject(ctx, project);
    if (due.length === 50)
      await ctx.scheduler.runAfter(
        0,
        internal.projects.retireSunsetProjects,
        {},
      );
  },
});
