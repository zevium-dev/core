import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getOrgByPublicHandle,
  requireProjectAdmin,
  requireProjectMember,
  requireSpecVersionAdmin,
} from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import {
  decryptCredential,
  requireEncryptedCredential,
} from "./lib/credentialCrypto";
import {
  credentialSetFingerprint,
  draftFingerprint,
  readinessValidity,
} from "./publishReadiness";
import { enqueueRouteUpsert } from "./registrySync";
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
  ): Promise<{
    draft: string;
    draftHash: string;
    lastSavedAt: number;
  } | null> => {
    await requireProjectMember(ctx, args.projectId);
    const row = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (row === null) return null;
    return {
      draft: row.draft,
      draftHash: await draftFingerprint(row.draft),
      lastSavedAt: row.lastSavedAt,
    };
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
    draftHash?: string;
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

    if (existing !== null && existing.draft === args.spec) {
      return {
        ok: true,
        issues: effectiveIssues,
        draft: existing.draft,
        draftHash: await draftFingerprint(existing.draft),
        lastSavedAt: existing.lastSavedAt,
      };
    }

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
    const readiness = await ctx.db
      .query("publishReadiness")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    if (readiness) await ctx.db.delete(readiness._id);

    return {
      ok: true,
      issues: effectiveIssues,
      draft: args.spec,
      draftHash: await draftFingerprint(args.spec),
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
    const { org } = await requireProjectAdmin(ctx, args.projectId);

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
    const draftForReadiness = await ctx.db
      .query("specs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const credentialRows = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const credentialRevision = credentialRows.reduce(
      (latest, row) => Math.max(latest, row.updatedAt),
      0,
    );
    const credentialFingerprint =
      await credentialSetFingerprint(credentialRows);
    const readiness = await ctx.db
      .query("publishReadiness")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const readinessState = await readinessValidity(
      readiness,
      draftForReadiness?.draft ?? null,
      credentialRevision,
      credentialFingerprint,
    );
    if (!readinessState.current) {
      const readinessMessages = {
        missing: "Run a passing connection test before publishing.",
        draft_missing:
          "Save a draft, then run a passing connection test before publishing.",
        status_not_ok: "Run a passing connection test before publishing.",
        expired:
          "The passing connection test expired. Run it again before publishing.",
        draft_changed:
          "The saved draft changed after the connection test. Run it again before publishing.",
        credentials_changed:
          "Credentials changed after the connection test. Run it again before publishing.",
      } as const;
      return {
        ok: false,
        issues: [
          {
            level: "error",
            path: "readiness",
            message: readinessMessages[readinessState.reason],
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
    // Notify publisher org + fire webhook event.
    await createNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "spec_published",
      title: "Spec published",
      body: `Version ${version} published for ${project.name}.`,
      refId: `spec_published:${versionId}`,
    });
    await fireWebhookEvent(ctx, args.projectId, "spec.published", {
      projectId: args.projectId,
      version,
    });
    // Rebuild the catalogue search embedding from the new published spec.
    await ctx.scheduler.runAfter(0, internal.search.embedProject, {
      projectId: args.projectId,
    });
    await enqueueRouteUpsert(ctx, args.projectId);

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
      deprecatedAt: number | undefined;
      sunsetAt: number | undefined;
      deprecationMessage: string | undefined;
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
      deprecatedAt: r.deprecatedAt,
      sunsetAt: r.sunsetAt,
      deprecationMessage: r.deprecationMessage,
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
    publisherHandle: v.string(),
    projectSlug: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    spec: string;
    version: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
    visibility: Doc<"projects">["visibility"];
    deprecatedAt: number | undefined;
    sunsetAt: number | undefined;
    deprecationMessage: string | undefined;
  } | null> => {
    const org = await getOrgByPublicHandle(ctx, args.publisherHandle);
    if (org === null || org.retiringAt !== undefined) return null;

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .filter((q) => q.eq(q.field("visibility"), "public"))
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
      version: latest.version,
      projectId: project._id,
      organizationId: org._id,
      clerkOrgId: org.clerkOrgId,
      visibility: project.visibility,
      deprecatedAt: latest.deprecatedAt,
      sunsetAt: latest.sunsetAt,
      deprecationMessage: latest.deprecationMessage,
    };
  },
});

/**
 * Internal gateway lookup. Same immutable published snapshot as public query,
 * plus publisher-owned headers. Only reachable through authenticated httpAction.
 */
export const getPublishedForGatewayInternal = internalQuery({
  args: {
    publisherHandle: v.string(),
    projectSlug: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    spec: string;
    version: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
    visibility: Doc<"projects">["visibility"];
    upstreamHeaders: Record<string, string>;
    deprecatedAt: number | undefined;
    sunsetAt: number | undefined;
    deprecationMessage: string | undefined;
  } | null> => {
    const org = await getOrgByPublicHandle(ctx, args.publisherHandle);
    if (org === null) return null;

    const project = await ctx.db
      .query("projects")
      .withIndex("by_org_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.projectSlug),
      )
      .unique();
    if (
      project === null ||
      project.status !== "published" ||
      project.retiringAt !== undefined
    ) {
      return null;
    }

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (latest === null) return null;

    const upstreamHeaders = await ctx.db
      .query("upstreamCredentials")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();

    return {
      spec: latest.spec,
      version: latest.version,
      projectId: project._id,
      organizationId: org._id,
      clerkOrgId: org.clerkOrgId,
      visibility: project.visibility,
      upstreamHeaders: Object.fromEntries(
        await Promise.all(
          upstreamHeaders.map(async (row) => [
            row.name,
            await decryptCredential(
              requireEncryptedCredential(row),
              row.projectId,
              row.name,
            ),
          ]),
        ),
      ),
      deprecatedAt: latest.deprecatedAt,
      sunsetAt: latest.sunsetAt,
      deprecationMessage: latest.deprecationMessage,
    };
  },
});

/**
 * Deprecate a published version (metadata only — spec body immutable).
 * Auth: org admin owning the project.
 * Fires version_deprecated notification + spec.deprecated webhook.
 */
export const deprecateVersion = mutation({
  args: {
    versionId: v.id("specVersions"),
    sunsetAt: v.optional(v.number()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"specVersions">> => {
    const { org, version } = await requireSpecVersionAdmin(ctx, args.versionId);

    const now = Date.now();
    await ctx.db.patch(args.versionId, {
      deprecatedAt: now,
      sunsetAt: args.sunsetAt,
      deprecationMessage: args.message,
    });

    await createNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "version_deprecated",
      title: "Version deprecated",
      body: `Version ${version.version} has been deprecated${args.message !== undefined ? `: ${args.message}` : ""}.`,
      refId: `version_deprecated:${args.versionId}`,
    });

    await fireWebhookEvent(ctx, version.projectId, "spec.deprecated", {
      projectId: version.projectId,
      version: version.version,
      sunsetAt: args.sunsetAt,
    });

    const updated = await ctx.db.get(args.versionId);
    if (updated === null) {
      throw new Error("Failed to load version");
    }
    await enqueueRouteUpsert(ctx, version.projectId);
    return updated;
  },
});

/**
 * Clear deprecation metadata from a version.
 * Auth: org admin owning the project.
 */
export const undeprecateVersion = mutation({
  args: { versionId: v.id("specVersions") },
  handler: async (ctx, args): Promise<Doc<"specVersions">> => {
    const { version } = await requireSpecVersionAdmin(ctx, args.versionId);

    // Replace to unset optional fields — patch cannot delete them.
    await ctx.db.replace(args.versionId, {
      projectId: version.projectId,
      version: version.version,
      spec: version.spec,
      publishedAt: version.publishedAt,
    });

    const updated = await ctx.db.get(args.versionId);
    if (updated === null) {
      throw new Error("Failed to load version");
    }
    await enqueueRouteUpsert(ctx, version.projectId);
    return updated;
  },
});
