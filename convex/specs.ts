import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getOrgBySlug, requireProjectMember } from "./lib/auth";
import {
  isValidSemver,
  type SpecIssue,
  validateOpenApiSpec,
} from "./lib/validate";

export const getDraft = query({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<{ draft: string; lastSavedAt: number } | null> => {
    await requireProjectMember(ctx, args.projectId);
    const row = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (row === null) return null;
    return { draft: row.draft, lastSavedAt: row.lastSavedAt };
  },
});

export const saveDraft = mutation({
  args: {
    projectId: v.id("projects"),
    spec: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    issues: SpecIssue[];
    draft: string;
    lastSavedAt: number;
  }> => {
    await requireProjectMember(ctx, args.projectId);

    const issues = validateOpenApiSpec(args.spec);
    // Empty draft is allowed to clear editor; only non-empty drafts must parse.
    const effectiveIssues = args.spec.trim() === "" ? [] : issues;

    const hasError = effectiveIssues.some((i) => i.level === "error");
    if (hasError) {
      return {
        ok: false,
        issues: effectiveIssues,
        draft: args.spec,
        lastSavedAt: 0,
      };
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();

    if (existing === null) {
      await ctx.db.insert("specs", {
        projectId: args.projectId,
        draft: args.spec,
        lastSavedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        draft: args.spec,
        lastSavedAt: now,
      });
    }

    return {
      ok: true,
      issues: effectiveIssues,
      draft: args.spec,
      lastSavedAt: now,
    };
  },
});

export const publish = mutation({
  args: {
    projectId: v.id("projects"),
    version: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    issues: SpecIssue[];
    version?: Doc<"specVersions">;
    project?: Doc<"projects">;
  }> => {
    await requireProjectMember(ctx, args.projectId);

    const version = args.version.trim();
    if (!isValidSemver(version)) {
      return {
        ok: false,
        issues: [
          {
            level: "error",
            path: "version",
            message: "Version must be valid semver (e.g. 0.1.0)",
          },
        ],
      };
    }

    const existingVersion = await ctx.db
      .query("specVersions")
      .withIndex("by_project_version", (q) =>
        q.eq("projectId", args.projectId).eq("version", version),
      )
      .unique();
    if (existingVersion !== null) {
      return {
        ok: false,
        issues: [
          {
            level: "error",
            path: "version",
            message: `Version ${version} already published (immutable)`,
          },
        ],
      };
    }

    const draftRow = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (draftRow === null || draftRow.draft.trim() === "") {
      return {
        ok: false,
        issues: [
          {
            level: "error",
            path: "$",
            message: "Save a draft spec before publishing",
          },
        ],
      };
    }

    const issues = validateOpenApiSpec(draftRow.draft);
    if (issues.some((i) => i.level === "error")) {
      return { ok: false, issues };
    }

    const publishedAt = Date.now();
    const versionId = await ctx.db.insert("specVersions", {
      projectId: args.projectId,
      version,
      spec: draftRow.draft,
      publishedAt,
    });

    await ctx.db.patch(args.projectId, { status: "published" });

    const versionDoc = await ctx.db.get(versionId);
    const project = await ctx.db.get(args.projectId);
    if (versionDoc === null || project === null) {
      throw new Error("Failed to load published version");
    }

    return {
      ok: true,
      issues, // warnings (e.g. missing x-zevium-cost) still returned
      version: versionDoc,
      project,
    };
  },
});

export const listVersions = query({
  args: { projectId: v.id("projects") },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      _id: Doc<"specVersions">["_id"];
      version: string;
      publishedAt: number;
    }>
  > => {
    await requireProjectMember(ctx, args.projectId);
    const rows = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      version: r.version,
      publishedAt: r.publishedAt,
    }));
  },
});

/**
 * Fetch one immutable published version (full spec body).
 * Auth: caller must be a member of the org that owns the project.
 */
export const getVersion = query({
  args: { versionId: v.id("specVersions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ version: string; spec: string; publishedAt: number }> => {
    const row = await ctx.db.get(args.versionId);
    if (row === null) {
      throw new Error("Spec version not found");
    }
    await requireProjectMember(ctx, row.projectId);
    return {
      version: row.version,
      spec: row.spec,
      publishedAt: row.publishedAt,
    };
  },
});

/**
 * Public (no-auth) query for the gateway data plane.
 * Returns latest published immutable snapshot + org ids for wallet DO routing.
 */
export const getPublishedForGateway = query({
  args: {
    orgSlug: v.string(),
    projectSlug: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    spec: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
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
    if (project.status !== "published") return null;

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (latest === null) return null;

    return {
      spec: latest.spec,
      projectId: project._id,
      organizationId: org._id,
      clerkOrgId: org.clerkOrgId,
    };
  },
});
