import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireOrgAdminBySlug,
  requireOrgMemberBySlug,
  requireProjectAdmin,
} from "./lib/auth";
import { isValidSlug } from "./lib/validate";
import { enqueueRouteUpsert } from "./registrySync";
import { beginProjectRetirement } from "./retirementJobs";

export const list = query({
  args: { orgSlug: v.string() },
  handler: async (ctx, args): Promise<Doc<"projects">[]> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    return await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .collect();
  },
});

export const get = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"projects"> | null> => {
    const { org } = await requireOrgMemberBySlug(ctx, args.orgSlug);
    return await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
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
    const { org } = await requireOrgAdminBySlug(ctx, args.orgSlug);

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
    const { project: current } = await requireProjectAdmin(ctx, args.projectId);

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
    await enqueueRouteUpsert(ctx, args.projectId);
    return updated;
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<{ retiring: Id<"projects"> }> => {
    const { project, org } = await requireProjectAdmin(ctx, args.projectId, {
      allowRetiring: true,
    });
    await beginProjectRetirement(ctx, project, org);
    return { retiring: args.projectId };
  },
});
