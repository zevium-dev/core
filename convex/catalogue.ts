import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getOrgBySlug } from "./lib/auth";

const PAGE_SIZE = 24;

export type PublicListing = {
  projectId: Doc<"projects">["_id"];
  name: string;
  slug: string;
  description: string | undefined;
  tags: string[];
  organizationId: Doc<"organizations">["_id"];
  orgName: string;
  orgSlug: string;
  publishedAt: number | null;
};

export const listPublic = query({
  args: {
    search: v.optional(v.string()),
    tag: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    items: PublicListing[];
    nextCursor: string | null;
  }> => {
    const search =
      args.search === undefined ? "" : args.search.trim().toLowerCase();
    const tag = args.tag === undefined ? "" : args.tag.trim().toLowerCase();
    const offset =
      args.cursor !== undefined && args.cursor !== ""
        ? Number.parseInt(args.cursor, 10)
        : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

    // Public catalogue is still small; filter in memory after index scan.
    // Later: vectorIndex + searchIndex (TECH.md).
    const candidates = await ctx.db
      .query("projects")
      .withIndex("by_visibility_status", (q) =>
        q.eq("visibility", "public").eq("status", "published"),
      )
      .collect();

    const filtered: Array<{
      project: Doc<"projects">;
      org: Doc<"organizations">;
      publishedAt: number | null;
    }> = [];

    for (const project of candidates) {
      if (tag !== "" && !project.tags.includes(tag)) continue;

      if (search !== "") {
        const hay =
          `${project.name} ${project.slug} ${project.description ?? ""} ${project.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(search)) continue;
      }

      const org = await ctx.db.get(project.organizationId);
      if (org === null) continue;

      const latest = await ctx.db
        .query("specVersions")
        .withIndex("by_project_published", (q) =>
          q.eq("projectId", project._id),
        )
        .order("desc")
        .first();

      filtered.push({
        project,
        org,
        publishedAt: latest?.publishedAt ?? null,
      });
    }

    filtered.sort((a, b) => {
      const ap = a.publishedAt ?? 0;
      const bp = b.publishedAt ?? 0;
      if (bp !== ap) return bp - ap;
      return a.project.name.localeCompare(b.project.name);
    });

    const page = filtered.slice(start, start + PAGE_SIZE);
    const nextOffset = start + PAGE_SIZE;
    const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;

    return {
      items: page.map(({ project, org, publishedAt }) => ({
        projectId: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        organizationId: org._id,
        orgName: org.name,
        orgSlug: org.slug,
        publishedAt,
      })),
      nextCursor,
    };
  },
});

export const getPublicDetail = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    project: {
      _id: Doc<"projects">["_id"];
      name: string;
      slug: string;
      description: string | undefined;
      tags: string[];
      status: Doc<"projects">["status"];
      visibility: Doc<"projects">["visibility"];
    };
    org: {
      _id: Doc<"organizations">["_id"];
      name: string;
      slug: string;
      imageUrl: string | undefined;
    };
    latestVersion: {
      version: string;
      spec: string;
      publishedAt: number;
    } | null;
  } | null> => {
    const org = await getOrgBySlug(ctx, args.orgSlug);
    if (org === null) return null;

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (project === null) return null;
    if (project.visibility !== "public" || project.status !== "published") {
      return null;
    }

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();

    return {
      project: {
        _id: project._id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        status: project.status,
        visibility: project.visibility,
      },
      org: {
        _id: org._id,
        name: org.name,
        slug: org.slug,
        imageUrl: org.imageUrl,
      },
      latestVersion:
        latest === null
          ? null
          : {
              version: latest.version,
              spec: latest.spec,
              publishedAt: latest.publishedAt,
            },
    };
  },
});
