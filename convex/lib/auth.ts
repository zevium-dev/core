import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type OrgIdentityClaims = {
  subject: string;
  email: string | undefined;
  orgId: string | undefined;
  orgSlug: string | undefined;
  orgRole: string | undefined;
};

type DbCtx = QueryCtx | MutationCtx;
type AuthCtx = Pick<QueryCtx, "auth">;

export async function requireIdentity(
  ctx: AuthCtx,
): Promise<OrgIdentityClaims> {
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
  const email = typeof identity.email === "string" ? identity.email : undefined;

  return {
    subject: identity.subject,
    email,
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

/** Public routing uses the product handle, never the Clerk slug. */
export async function getOrgByPublicHandle(
  ctx: DbCtx,
  handle: string,
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_public_handle", (q) =>
      q.eq("publicHandle", handle.trim().toLowerCase()),
    )
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

/**
 * Resolve an org-admin mutation by slug without confirming whether another
 * organization's slug exists. This keeps cross-org failures indistinguishable
 * from missing resources while same-org members receive a useful role error.
 */
export async function requireOrgAdminBySlug(
  ctx: DbCtx,
  orgSlug: string,
): Promise<{ claims: OrgIdentityClaims; org: Doc<"organizations"> }> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) {
    throw new Error("No active organization on identity");
  }

  const org = await getOrgBySlug(ctx, orgSlug);
  if (org === null || org.clerkOrgId !== claims.orgId) {
    throw new Error("Organization not found");
  }
  requireOrgAdmin(claims);

  return { claims, org };
}

/**
 * Resolve an org-admin mutation by project id. Cross-org callers receive the
 * same error as an unknown project id, preventing project-id enumeration.
 */
export async function requireProjectAdmin(
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
  if (org === null || org.clerkOrgId !== claims.orgId) {
    throw new Error("Project not found");
  }
  requireOrgAdmin(claims);

  return { claims, org, project };
}

/** Admin gate for version lifecycle writes with non-enumerating failures. */
export async function requireSpecVersionAdmin(
  ctx: DbCtx,
  versionId: Id<"specVersions">,
): Promise<{
  claims: OrgIdentityClaims;
  org: Doc<"organizations">;
  project: Doc<"projects">;
  version: Doc<"specVersions">;
}> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) {
    throw new Error("No active organization on identity");
  }

  const version = await ctx.db.get(versionId);
  if (version === null) {
    throw new Error("Version not found");
  }
  const project = await ctx.db.get(version.projectId);
  if (project === null) {
    throw new Error("Version not found");
  }
  const org = await ctx.db.get(project.organizationId);
  if (org === null || org.clerkOrgId !== claims.orgId) {
    throw new Error("Version not found");
  }
  requireOrgAdmin(claims);

  return { claims, org, project, version };
}

/**
 * Enforce org-admin role from the Clerk JWT claim (`org_role === "org:admin"`).
 * `claims.orgRole` is parsed by `requireIdentity` but, without this gate, any
 * org member can perform admin actions. Callers resolve claims first via
 * `requireIdentity` / `requireOrgMemberBySlug` / `requireProjectMember`, then
 * pass the returned `claims` here.
 *
 * Returns the claims for chaining. Does NOT touch the DB.
 *
 * Read-only queries and member collaboration mutations intentionally stay at
 * `requireOrgMemberBySlug` / `requireProjectMember`. Lifecycle, billing, payout,
 * secret, and org-setting writes must use one of the admin-resolving helpers.
 */
export function requireOrgAdmin(claims: OrgIdentityClaims): OrgIdentityClaims {
  if (claims.orgRole !== "org:admin") {
    throw new Error("Org admin role required");
  }
  return claims;
}

export type ActiveOrgAdminClaims = OrgIdentityClaims & { orgId: string };

/** Authenticate an action and require an active Clerk org-admin membership. */
export async function requireActiveOrgAdmin(
  ctx: AuthCtx,
): Promise<ActiveOrgAdminClaims> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined || claims.orgId.trim() === "") {
    throw new Error("Active organization required");
  }
  requireOrgAdmin(claims);
  return { ...claims, orgId: claims.orgId };
}

/**
 * Platform admin gate. Reads ADMIN_USER_IDS env (comma-separated Clerk user ids).
 * Fails closed when env unset — nobody is admin.
 */
export async function requireAdmin(ctx: DbCtx): Promise<OrgIdentityClaims> {
  const claims = await requireIdentity(ctx);
  const raw = process.env.ADMIN_USER_IDS;
  if (raw === undefined || raw.trim() === "") {
    throw new Error("Admin access not configured");
  }
  const adminIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!adminIds.includes(claims.subject)) {
    throw new Error("Not authorized as admin");
  }
  return claims;
}

/**
 * Safe admin check (no throw). Returns false when env unset or user not listed.
 */
export async function isAdmin(ctx: DbCtx): Promise<boolean> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return false;
  const raw = process.env.ADMIN_USER_IDS;
  if (raw === undefined || raw.trim() === "") return false;
  const adminIds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return adminIds.includes(identity.subject);
}
