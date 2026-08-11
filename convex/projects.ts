import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireOrgAdmin,
  requireOrgMemberBySlug,
  requireProjectMember,
} from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import { isValidSlug } from "./lib/validate";

export const MIN_DEPRECATION_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

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
    .collect();
  for (const credential of credentials) await ctx.db.delete(credential._id);

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
        retiredAt: Date.now(),
      });
    }
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
      args.sunsetAt < now + MIN_DEPRECATION_NOTICE_MS
    ) {
      throw new Error("Sunset must provide at least 7 days notice");
    }
    const message = args.message.trim();
    if (message.length === 0 || message.length > 1000) {
      throw new Error("Deprecation message must be 1-1000 characters");
    }
    const deprecationStartedAt = project.deprecationStartedAt ?? now;
    await ctx.db.patch(project._id, {
      deprecationStartedAt,
      sunsetAt: args.sunsetAt,
      deprecationMessage: message,
    });
    await createNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "version_deprecated",
      title: "Project retirement scheduled",
      body: `${project.name} will sunset ${new Date(args.sunsetAt).toISOString()}.`,
      refId: `project_retirement:${project._id}:${deprecationStartedAt}`,
    });
    await fireWebhookEvent(ctx, project._id, "project.deprecated", {
      projectId: project._id,
      sunsetAt: args.sunsetAt,
      message,
    });
    const updated = await ctx.db.get(project._id);
    if (updated === null) throw new Error("Project not found");
    return updated;
  },
});

export const cancelRetirement = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Doc<"projects">> => {
    const { claims, project } = await requireProjectMember(ctx, args.projectId);
    requireOrgAdmin(claims);
    if (project.retiredAt !== undefined) {
      throw new Error("Retired projects cannot be restored");
    }
    if (project.sunsetAt !== undefined && project.sunsetAt <= Date.now()) {
      throw new Error("Retirement cannot be canceled after sunset");
    }
    await ctx.db.replace(project._id, {
      organizationId: project.organizationId,
      name: project.name,
      slug: project.slug,
      description: project.description,
      status: project.status,
      visibility: project.visibility,
      tags: project.tags,
    });
    const updated = await ctx.db.get(project._id);
    if (updated === null) throw new Error("Project not found");
    return updated;
  },
});

/** Hourly bounded sunset cleanup. Immutable versions and usage history remain. */
export const retireSunsetProjects = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ retired: number }> => {
    const now = Date.now();
    const candidates = await ctx.db
      .query("projects")
      .withIndex("by_sunset", (q) => q.gt("sunsetAt", 0).lte("sunsetAt", now))
      .take(100);
    let retired = 0;
    for (const project of candidates) {
      if (
        project.sunsetAt === undefined ||
        project.retiredAt !== undefined ||
        project.deprecationStartedAt === undefined
      ) {
        continue;
      }
      await cleanupProjectRuntime(ctx, project._id);
      await ctx.db.patch(project._id, {
        visibility: "private",
        retiredAt: now,
      });
      retired += 1;
    }
    return { retired };
  },
});
