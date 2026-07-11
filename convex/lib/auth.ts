import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type OrgIdentityClaims = {
  subject: string;
  orgId: string | undefined;
  orgSlug: string | undefined;
  orgRole: string | undefined;
};

type DbCtx = QueryCtx | MutationCtx;

export async function requireIdentity(ctx: DbCtx): Promise<OrgIdentityClaims> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Not authenticated");
  }

  // Clerk JWT template "convex" maps org claims as org_id / org_slug / org_role.
  // Convex flattens custom claims onto the identity object.
  const raw = identity as Record<string, unknown>;
  const orgId =
    typeof raw.org_id === "string"
      ? raw.org_id
      : typeof raw.orgId === "string"
        ? raw.orgId
        : undefined;
  const orgSlug =
    typeof raw.org_slug === "string"
      ? raw.org_slug
      : typeof raw.orgSlug === "string"
        ? raw.orgSlug
        : undefined;
  const orgRole =
    typeof raw.org_role === "string"
      ? raw.org_role
      : typeof raw.orgRole === "string"
        ? raw.orgRole
        : undefined;

  return {
    subject: identity.subject,
    orgId,
    orgSlug,
    orgRole,
  };
}

export async function getOrgBySlug(
  ctx: DbCtx,
  slug: string,
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * Resolve org by slug and require the JWT active org claim matches it.
 * Creator/editor must be a member of the org (Clerk org claim).
 */
export async function requireOrgMemberBySlug(
  ctx: DbCtx,
  orgSlug: string,
): Promise<{ claims: OrgIdentityClaims; org: Doc<"organizations"> }> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) {
    throw new Error("No active organization on identity");
  }

  const org = await getOrgBySlug(ctx, orgSlug);
  if (org === null) {
    throw new Error("Organization not found");
  }
  if (org.clerkOrgId !== claims.orgId) {
    throw new Error("Not a member of this organization");
  }

  return { claims, org };
}

/**
 * Resolve project and require JWT membership of its owning org.
 */
export async function requireProjectMember(
  ctx: DbCtx,
  projectId: Id<"projects">,
): Promise<{
  claims: OrgIdentityClaims;
  org: Doc<"organizations">;
  project: Doc<"projects">;
}> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) {
    throw new Error("No active organization on identity");
  }

  const project = await ctx.db.get(projectId);
  if (project === null) {
    throw new Error("Project not found");
  }

  const org = await ctx.db.get(project.organizationId);
  if (org === null) {
    throw new Error("Organization not found");
  }
  if (org.clerkOrgId !== claims.orgId) {
    throw new Error("Not a member of this organization");
  }

  return { claims, org, project };
}
