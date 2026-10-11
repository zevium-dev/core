import { limitLifecycle, publicationNotice } from "./lifecycleNotices";
import { upsertNotification } from "./lib/notifications";
import { fireWebhookEvent } from "./webhooks";
import { syncCatalogue, adjustStat } from "./lib/catalogue";
import { setupQuality } from "./quality";
import { internal } from "./_generated/api";
import { getProjectDraft, draftConflict } from "./lib/drafts";
import { v, ConvexError } from "convex/values";
import { isValidSemver, sha256Hex } from "@zevium/shared";
import { mutation, query } from "./_generated/server";
import {
  requireProjectMember,
  requireProjectAdmin,
  requireSpecVersionAdmin,
} from "./lib/auth";
import { projectDto, versionDto } from "./lib/dto";
import {
  reservePublicRoute,
  resolveActivePublicRoute,
} from "./lib/publicRoutes";
import { pricingSummary, specIssues } from "./lib/specPolicy";
import { readinessValidity } from "./publishReadiness";
import { MIN_DEPRECATION_NOTICE_MS } from "./projects";
export const getDraft = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectMember(ctx, args.projectId);
    const draft = await getProjectDraft(ctx, project._id);
    return draft
      ? {
          draft: draft.text,
          draftHash: draft.hash,
          lastSavedAt: draft.savedAt,
        }
      : null;
  },
});
export const saveDraft = mutation({
  args: {
    projectId: v.id("projects"),
    spec: v.string(),
    baseHash: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectMember(ctx, args.projectId);
    const issues = args.spec.trim() ? specIssues(args.spec) : [];
    if (issues.some((i) => i.level === "error"))
      return { ok: false, issues, draft: args.spec, lastSavedAt: 0 };
    const current = await getProjectDraft(ctx, project._id);
    if (current?.text === args.spec)
      return {
        ok: true,
        issues,
        draft: current.text,
        draftHash: current.hash,
        lastSavedAt: current.savedAt,
      };
    if (args.baseHash !== (current?.hash ?? null))
      return draftConflict(current);
    const draft = {
      revision: (current?.revision ?? 0) + 1,
      hash: await sha256Hex(args.spec),
      savedAt: Date.now(),
    };
    if (current) await ctx.db.patch(current._id, { ...draft, text: args.spec });
    else
      await ctx.db.insert("projectDrafts", {
        projectId: project._id,
        ...draft,
        text: args.spec,
      });
    await ctx.db.patch(project._id, { draft });
    return {
      ok: true,
      issues,
      draft: args.spec,
      draftHash: draft.hash,
      lastSavedAt: draft.savedAt,
    };
  },
});
export const publish = mutation({
  args: {
    projectId: v.id("projects"),
    version: v.string(),
    draftHash: v.string(),
  },
  handler: async (ctx, args) => {
    const { project, org } = await requireProjectAdmin(ctx, args.projectId);
    const draft = await getProjectDraft(ctx, project._id);
    if (args.draftHash !== (draft?.hash ?? null)) return draftConflict(draft);
    const version = args.version.trim();
    const error = (path: string, message: string) => ({
      ok: false,
      issues: [{ level: "error" as const, path, message }],
    });
    if (!isValidSemver(version))
      return error("version", "Version must be valid semver (e.g. 0.1.0)");
    if (project.retirement)
      return error("project", "Cancel retirement before publishing");
    if (
      await ctx.db
        .query("specVersions")
        .withIndex("by_version", (q) =>
          q.eq("projectId", project._id).eq("version", version),
        )
        .unique()
    )
      return error(
        "version",
        `Version ${version} already published (immutable)`,
      );
    if (!draft?.text.trim())
      return error("$", "Save a draft spec before publishing");
    const issues = specIssues(draft.text);
    if (issues.some((i) => i.level === "error")) return { ok: false, issues };
    if (!(await readinessValidity(ctx, project)).current)
      return error(
        "readiness",
        "Run a passing connection test for the current draft and credentials before publishing.",
      );
    await reservePublicRoute(ctx, org, project);
    const publishedAt = Date.now();
    const id = await ctx.db.insert("specVersions", {
      projectId: project._id,
      version,
      spec: draft.text,
      contentHash: draft.hash,
      publishedAt,
    });
    await ctx.db.patch(project._id, {
      status: "published",
      latestVersionId: id,
      publicationGeneration: project.publicationGeneration + 1,
      revision: project.revision + 1,
      publishedAt,
      ...pricingSummary(draft.text),
      discoverable:
        project.visibility === "public" && project.qualityStatus === "active",
    });
    await syncCatalogue(ctx, project, (await ctx.db.get(project._id))!);
    if (project.status === "draft") {
      await adjustStat(ctx, "draft", project._id, -1);
      await adjustStat(ctx, "published", project._id, 1);
    }
    await setupQuality(ctx, project._id);
    await publicationNotice(
      ctx,
      (await ctx.db.get(project._id))!,
      (await ctx.db.get(id))!,
    );
    return {
      ok: true,
      issues,
      version: versionDto((await ctx.db.get(id))!),
      project: projectDto((await ctx.db.get(project._id))!),
    };
  },
});
export const listVersions = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectMember(ctx, args.projectId);
    const rows = await ctx.db
      .query("specVersions")
      .withIndex("by_project_time", (q) => q.eq("projectId", args.projectId))
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
export const getVersion = query({
  args: { versionId: v.id("specVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;
    await requireProjectMember(ctx, version.projectId);
    return {
      version: version.version,
      spec: version.spec,
      publishedAt: version.publishedAt,
    };
  },
});
export const getPublishedForGateway = query({
  args: { publisherHandle: v.string(), projectSlug: v.string() },
  handler: async (ctx, args) => {
    const route = await resolveActivePublicRoute(
      ctx,
      args.publisherHandle,
      args.projectSlug,
    );
    if (!route?.project.latestVersionId) return null;
    const version = await ctx.db.get(route.project.latestVersionId);
    if (
      !version ||
      version.projectId !== route.project._id ||
      specIssues(version.spec).some((i) => i.level === "error")
    )
      return null;
    return {
      spec: version.spec,
      version: version.version,
      specVersionId: version._id,
      visibility: route.project.visibility,
      deprecatedAt: route.project.retirement?.startedAt ?? version.deprecatedAt,
      sunsetAt: route.project.retirement?.sunsetAt,
      deprecationMessage:
        route.project.retirement?.message ?? version.deprecationMessage,
      retiredAt: route.project.retirement?.retiredAt,
    };
  },
});
export const deprecateVersion = mutation({
  args: {
    versionId: v.id("specVersions"),
    sunsetAt: v.optional(v.number()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { version, project } = await requireSpecVersionAdmin(
      ctx,
      args.versionId,
    );
    if (version.sunsetAt !== undefined && version.sunsetAt <= Date.now())
      throw new ConvexError("A version cannot be changed after its sunset");
    if (
      args.sunsetAt !== undefined &&
      (!Number.isSafeInteger(args.sunsetAt) ||
        !Number.isFinite(new Date(args.sunsetAt).getTime()) ||
        args.sunsetAt < Date.now() + MIN_DEPRECATION_NOTICE_MS)
    )
      throw new ConvexError(
        "Sunset must be a safe timestamp at least 7 days away",
      );
    const message = args.message?.trim();
    if (message !== undefined && (!message || message.length > 1000))
      throw new ConvexError("Deprecation message must be 1 to 1000 characters");
    if (
      version.deprecatedAt !== undefined &&
      version.sunsetAt === args.sunsetAt &&
      version.deprecationMessage === (message ?? version.deprecationMessage)
    )
      return versionDto(version);
    await limitLifecycle(ctx, project);
    await ctx.db.patch(version._id, {
      deprecatedAt: version.deprecatedAt ?? Date.now(),
      noticeRevision: (version.noticeRevision ?? 0) + 1,
      sunsetAt: args.sunsetAt,
      deprecationMessage: message ?? version.deprecationMessage,
    });
    await ctx.db.patch(project._id, { revision: project.revision + 1 });
    const changed = await ctx.db.get(version._id);
    if (
      changed?.deprecatedAt !== undefined &&
      (version.deprecatedAt !== changed.deprecatedAt ||
        version.sunsetAt !== changed.sunsetAt ||
        version.deprecationMessage !== changed.deprecationMessage)
    ) {
      const body = `${project.name} version ${version.version} is deprecated. ${changed.deprecationMessage ?? "Migrate to the current version."}`;
      await upsertNotification(ctx, {
        organizationId: project.organizationId,
        kind: "version_deprecated",
        title: "Version deprecated",
        body,
        refId: `deprecation:${version._id}`,
        email: version.deprecatedAt === undefined,
      });
      await fireWebhookEvent(ctx, project._id, "spec.deprecated", {
        projectId: project._id,
        version: version.version,
      });
      await ctx.scheduler.runAfter(0, internal.lifecycleNotices.consumers, {
        projectId: project._id,
        revision: changed.noticeRevision!,
        email: version.deprecatedAt === undefined,
        versionId: version._id,
        cursor: null,
        body,
      });
    }
    return versionDto((await ctx.db.get(version._id))!);
  },
});
export const undeprecateVersion = mutation({
  args: { versionId: v.id("specVersions") },
  handler: async (ctx, args) => {
    const { version, project } = await requireSpecVersionAdmin(
      ctx,
      args.versionId,
    );
    if (version.sunsetAt !== undefined && version.sunsetAt <= Date.now())
      throw new ConvexError("A version cannot be changed after its sunset");
    await limitLifecycle(ctx, project);
    await ctx.db.patch(version._id, {
      deprecatedAt: undefined,
      noticeRevision: (version.noticeRevision ?? 0) + 1,
      sunsetAt: undefined,
      deprecationMessage: undefined,
    });
    await ctx.db.patch(project._id, { revision: project.revision + 1 });
    return versionDto((await ctx.db.get(version._id))!);
  },
});
