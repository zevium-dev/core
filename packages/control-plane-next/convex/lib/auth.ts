import { ConvexError } from "convex/values";
import { isPrivilegedOrgRole, projectOrgCapabilities } from "@zevium/shared";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function requireIdentity(ctx: Pick<QueryCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  const stringClaim = (primary: string, fallback: string) => {
    const value = identity[primary] ?? identity[fallback];
    return typeof value === "string" ? value : undefined;
  };
  return {
    subject: identity.subject,
    email: identity.email,
    orgId: stringClaim("org_id", "orgId"),
    orgSlug: stringClaim("org_slug", "orgSlug"),
    orgRole: stringClaim("org_role", "orgRole"),
  };
}
/** JWT identity selects tenant; mutable URL slugs never authorize it. */
export async function requireActiveOrg(ctx: Pick<QueryCtx, "auth" | "db">) {
  const claims = await requireIdentity(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", claims.subject))
    .unique();
  if (user?.deletedAt !== undefined) throw new ConvexError("Not authenticated");
  if (!claims.orgId) throw new ConvexError("Organization not found");
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_clerk", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  const tombstone = await ctx.db
    .query("orgTombstones")
    .withIndex("by_clerk", (q) => q.eq("clerkOrgId", claims.orgId!))
    .unique();
  if (!org || org.archivedAt !== undefined || tombstone)
    throw new ConvexError("Organization not found");
  const access = projectOrgCapabilities(claims.orgRole);
  if (!access) throw new ConvexError("Organization role is not supported");
  return { claims, org, access };
}
export function requireOrgAdmin(
  claims: Awaited<ReturnType<typeof requireIdentity>>,
) {
  if (!isPrivilegedOrgRole(claims.orgRole))
    throw new ConvexError("Org admin or owner role required");
  return claims;
}
export async function requireProjectMember(
  ctx: Pick<QueryCtx, "auth" | "db">,
  projectId: Id<"projects">,
) {
  const { claims, org } = await requireActiveOrg(ctx);
  const project = await ctx.db.get(projectId);
  if (
    !project ||
    project.organizationId !== org._id ||
    project.retirement?.state === "retired"
  )
    throw new ConvexError("Project not found");
  const route = await ctx.db
    .query("routeTombstones")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .first();
  if (route?.retiredAt !== undefined)
    throw new ConvexError("Project not found");
  return { claims, org, project };
}
export async function requireProjectAdmin(
  ctx: Pick<QueryCtx, "auth" | "db">,
  projectId: Id<"projects">,
) {
  const result = await requireProjectMember(ctx, projectId);
  requireOrgAdmin(result.claims);
  return result;
}

export async function requireSpecVersionAdmin(
  ctx: Pick<QueryCtx, "auth" | "db">,
  versionId: Id<"specVersions">,
) {
  const version = await ctx.db.get(versionId);
  if (!version) throw new ConvexError("Spec version not found");
  const result = await requireProjectAdmin(ctx, version.projectId);
  return { ...result, version };
}
