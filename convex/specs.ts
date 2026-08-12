import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireOrgAdmin,
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
import { syncCatalogueListing } from "./catalogue";
import { enqueuePublishedProjectProjection } from "./registrySync";
import { resolveActivePublicRoute } from "./lib/publicRoutes";
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
    const { claims, org } = await requireProjectMember(ctx, args.projectId);
    requireOrgAdmin(claims);

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
          "Run a new credential-free reachability test before publishing.",
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

    const currentProject = await ctx.db.get(args.projectId);
    if (currentProject === null) throw new Error("Project not found");
    await ctx.db.patch(args.projectId, {
      status: "published",
      publicationGeneration: (currentProject.publicationGeneration ?? 0) + 1,
    });

    const versionDoc = await ctx.db.get(versionId);
    const project = await ctx.db.get(args.projectId);
    if (versionDoc === null || project === null) {
      throw new Error("Failed to load published version");
    }
    await syncCatalogueListing(ctx, project._id);
    await enqueuePublishedProjectProjection(ctx, args.projectId);
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

    await ctx.scheduler.runAfter(0, internal.quality.syncPublishedTarget, {
      projectId: args.projectId,
      specVersionId: versionId,
    });

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
  ): Promise<{
    version: string;
    spec: string;
    publishedAt: number;
  } | null> => {
    const row = await ctx.db.get(args.versionId);
    if (row === null) {
      return null;
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
 * Public immutable spec DTO for docs, discovery, and keyless mocks.
 * Metering identifiers and Clerk identity stay behind gateway-spec httpAction.
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
    specVersionId: string;
    visibility: Doc<"projects">["visibility"];
    deprecatedAt: number | undefined;
    sunsetAt: number | undefined;
    deprecationMessage: string | undefined;
    retiredAt: number | undefined;
  } | null> => {
    const route = await resolveActivePublicRoute(
      ctx,
      args.publisherHandle,
      args.projectSlug,
    );
    if (route === null) return null;
    const { project } = route;
    if (project.visibility !== "public") return null;
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
      specVersionId: latest._id,
      visibility: project.visibility,
      deprecatedAt: project.deprecationStartedAt ?? latest.deprecatedAt,
      // Version sunset is informational. Only project retirement may cut off
      // execution, because that lifecycle owns consumer notice and wind-down.
      sunsetAt: project.sunsetAt ?? project.retirementCutoffAt,
      deprecationMessage:
        project.deprecationMessage ?? latest.deprecationMessage,
      retiredAt: project.retiredAt,
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
    specVersionId: string;
    projectId: string;
    organizationId: string;
    clerkOrgId: string;
    visibility: Doc<"projects">["visibility"];
    upstreamHeaders: Record<string, string>;
    deprecatedAt: number | undefined;
    sunsetAt: number | undefined;
    deprecationMessage: string | undefined;
    retiredAt: number | undefined;
  } | null> => {
    let route = await resolveActivePublicRoute(
      ctx,
      args.publisherHandle,
      args.projectSlug,
    );
    if (route === null) {
      // Retired routes lose their active binding but must still resolve so the
      // gateway can answer 410 with immutable deprecation metadata.
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_public_handle", (q) =>
          q.eq("publicHandle", args.publisherHandle.trim().toLowerCase()),
        )
        .unique();
      if (organization === null || organization.archivedAt !== undefined) {
        return null;
      }
      const candidates = await ctx.db
        .query("projects")
        .withIndex("by_org_slug", (q) =>
          q.eq("organizationId", organization._id).eq("slug", args.projectSlug),
        )
        .take(2);
      const retired = candidates.length === 1 ? candidates[0]! : null;
      if (retired === null || retired.retiredAt === undefined) return null;
      const tombstone = await ctx.db
        .query("publicRouteTombstones")
        .withIndex("by_project", (q) => q.eq("projectId", retired._id))
        .first();
      if (tombstone === null) return null;
      route = { organization, project: retired, binding: tombstone };
    }
    const { organization: org, project } = route;
    if (project.status !== "published") return null;

    const latest = await ctx.db
      .query("specVersions")
      .withIndex("by_project_published", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (latest === null) return null;

    const isPastSunset =
      project.retiredAt !== undefined ||
      (project.sunsetAt !== undefined && project.sunsetAt <= Date.now());
    const upstreamHeaders = isPastSunset
      ? []
      : await ctx.db
          .query("upstreamCredentials")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .collect();

    return {
      spec: latest.spec,
      version: latest.version,
      specVersionId: latest._id,
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
      deprecatedAt: project.deprecationStartedAt ?? latest.deprecatedAt,
      sunsetAt: project.sunsetAt ?? project.retirementCutoffAt,
      deprecationMessage:
        project.deprecationMessage ?? latest.deprecationMessage,
      retiredAt: project.retiredAt,
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
    if (version.sunsetAt !== undefined && version.sunsetAt <= now) {
      throw new Error("A version cannot be changed after its sunset");
    }
    if (
      args.sunsetAt !== undefined &&
      (!Number.isSafeInteger(args.sunsetAt) ||
        !Number.isFinite(new Date(args.sunsetAt).getTime()) ||
        args.sunsetAt < now + 7 * 24 * 60 * 60 * 1000)
    ) {
      throw new Error("Sunset must be a safe timestamp at least 7 days away");
    }
    const message = args.message?.trim();
    if (
      message !== undefined &&
      (message.length === 0 || message.length > 1000)
    ) {
      throw new Error("Deprecation message must be 1 to 1000 characters");
    }
    await ctx.db.patch(args.versionId, {
      deprecatedAt: version.deprecatedAt ?? now,
      sunsetAt: args.sunsetAt,
      deprecationMessage: message ?? version.deprecationMessage,
    });
    await enqueuePublishedProjectProjection(ctx, version.projectId);

    await createNotification(ctx, {
      clerkOrgId: org.clerkOrgId,
      kind: "version_deprecated",
      title: "Version deprecated",
      body: `Version ${version.version} has been deprecated${message !== undefined ? `: ${message}` : ""}.`,
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

    if (version.sunsetAt !== undefined && version.sunsetAt <= Date.now()) {
      throw new Error("A version cannot be restored after its sunset");
    }
    // Replace to unset optional fields — patch cannot delete them.
    await ctx.db.replace(args.versionId, {
      projectId: version.projectId,
      version: version.version,
      spec: version.spec,
      publishedAt: version.publishedAt,
    });
    await enqueuePublishedProjectProjection(ctx, version.projectId);

    const updated = await ctx.db.get(args.versionId);
    if (updated === null) {
      throw new Error("Failed to load version");
    }
    return updated;
  },
});
