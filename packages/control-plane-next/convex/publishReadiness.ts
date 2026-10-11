import { getProjectDraft } from "./lib/drafts";
import { v } from "convex/values";
import {
  extractHealthCheckTarget,
  parseSpec,
  sha256Hex,
  canonicalJson,
} from "@zevium/shared";
import {
  query,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireProjectAdmin, requireProjectMember } from "./lib/auth";
import { isActive } from "./lib/identity";
export const READINESS_TTL_MS = 15 * 60_000;
export async function credentialSetFingerprint(
  ctx: Pick<QueryCtx, "db">,
  projectId: Doc<"projects">["_id"],
) {
  const rows = await ctx.db
    .query("upstreamCredentials")
    .withIndex("by_project_name", (q) => q.eq("projectId", projectId))
    .collect();
  return sha256Hex(
    canonicalJson(
      rows.map((r) => ({
        id: r._id,
        name: r.name,
        revision: r.revision,
        updatedAt: r.updatedAt,
      })),
    ),
  );
}
export async function readinessValidity(
  ctx: Pick<QueryCtx, "db">,
  project: Doc<"projects">,
) {
  const draft = project.draft,
    proof = draft?.readiness;
  if (!draft) return { current: false, reason: "draft_missing" as const };
  if (!proof) return { current: false, reason: "missing" as const };
  if (
    proof.testedAt > Date.now() ||
    Date.now() - proof.testedAt > READINESS_TTL_MS
  )
    return { current: false, reason: "expired" as const };
  if (proof.draftHash !== draft.hash)
    return { current: false, reason: "draft_changed" as const };
  if (
    proof.credentialFingerprint !==
    (await credentialSetFingerprint(ctx, project._id))
  )
    return { current: false, reason: "credentials_changed" as const };
  return { current: true, reason: null };
}
export const getTarget = internalQuery({
  args: { projectId: v.id("projects"), clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId),
      org = project && (await ctx.db.get(project.organizationId));
    if (
      !project ||
      project.retirement?.state === "retired" ||
      !org ||
      org.clerkOrgId !== args.clerkOrgId ||
      !(await isActive(ctx, org))
    )
      throw new Error("Project not found");
    const draft = await getProjectDraft(ctx, project._id);
    const target = draft?.text
      ? extractHealthCheckTarget(parseSpec(draft.text))
      : null;
    return {
      url: target?.url ?? null,
      method: target?.method ?? null,
      draftHash: project.draft?.hash ?? null,
      credentialFingerprint: await credentialSetFingerprint(ctx, project._id),
    };
  },
});
export const recordPassingTest = internalMutation({
  args: {
    projectId: v.id("projects"),
    draftHash: v.string(),
    credentialFingerprint: v.string(),
    healthCheckUrl: v.string(),
    healthCheckMethod: v.union(v.literal("GET"), v.literal("HEAD")),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId),
      org = project && (await ctx.db.get(project.organizationId));
    if (
      !project?.draft ||
      project.retirement?.state === "retired" ||
      !org ||
      !(await isActive(ctx, org)) ||
      project.draft.hash !== args.draftHash ||
      args.credentialFingerprint !==
        (await credentialSetFingerprint(ctx, project._id))
    )
      return false;
    const draft = await getProjectDraft(ctx, project._id);
    if (!draft || draft.hash !== args.draftHash) return false;
    const target = extractHealthCheckTarget(parseSpec(draft.text));
    if (
      !target ||
      target.url !== args.healthCheckUrl ||
      target.method !== args.healthCheckMethod
    )
      return false;
    await ctx.db.patch(project._id, {
      draft: {
        ...project.draft,
        readiness: {
          draftHash: args.draftHash,
          credentialFingerprint: args.credentialFingerprint,
          url: target.url,
          method: target.method,
          testedAt: Date.now(),
        },
      },
    });
    return true;
  },
});
export const clearPassingTest = internalMutation({
  args: { projectId: v.id("projects"), draftHash: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.draft || project.draft.hash !== args.draftHash) return false;
    await ctx.db.patch(project._id, {
      draft: { ...project.draft, readiness: undefined },
    });
    return true;
  },
});
export const getCurrent = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectMember(ctx, args.projectId),
      proof = project.draft?.readiness;
    return {
      readiness: proof
        ? {
            draftHash: proof.draftHash,
            healthCheckUrl: proof.url,
            healthCheckMethod: proof.method,
            testedAt: proof.testedAt,
            status: "ok",
          }
        : null,
      ...(await readinessValidity(ctx, project)),
    };
  },
});

export const authorizeTest = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { org } = await requireProjectAdmin(ctx, args.projectId);
    return { clerkOrgId: org.clerkOrgId };
  },
});
