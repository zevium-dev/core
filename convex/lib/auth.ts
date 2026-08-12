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

/** Resolve tenant data from the immutable Clerk organization id in the JWT. */
export async function getOrgByClerkId(
  ctx: DbCtx,
  clerkOrgId: string,
): Promise<Doc<"organizations"> | null> {
  return await ctx.db
    .query("organizations")
    .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
}

/** Public routing uses the product handle, never the Clerk slug. */
export async function getOrgByPublicHandle(
  ctx: DbCtx,
  handle: string,
): Promise<Doc<"organizations"> | null> {
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_public_handle", (q) =>
      q.eq("publicHandle", handle.trim().toLowerCase()),
    )
    .unique();
  return org?.archivedAt === undefined ? org : null;
}

/**
 * Resolve active tenant exclusively from the JWT org id. `orgSlug` remains in
 * public function contracts for routing compatibility but never scopes data.
 */
export async function requireOrgMemberBySlug(
  ctx: DbCtx,
  _orgSlug: string,
): Promise<{ claims: OrgIdentityClaims; org: Doc<"organizations"> }> {
  const claims = await requireIdentity(ctx);
  if (claims.orgId === undefined) {
    throw new Error("No active organization on identity");
  }

  // URL slugs are mutable display/routing data. Authorization and data scope
  // come exclusively from the signed, immutable Clerk org id claim.
  const org = await getOrgByClerkId(ctx, claims.orgId);
  if (org === null) {
    throw new Error("Organization not found");
  }
  if (org.archivedAt !== undefined) {
    throw new Error("Organization is archived");
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
  if (org.archivedAt !== undefined) {
    throw new Error("Organization is archived");
  }
  if (org.clerkOrgId !== claims.orgId) {
    throw new Error("Not a member of this organization");
  }

  return { claims, org, project };
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
 * Mutations that SHOULD call `requireOrgAdmin(claims)` (caller migration is a
 * separate PR — this helper is exported but not yet wired in):
 *   - projects.create / projects.update / projects.remove
 *       (project lifecycle: create, rename, transfer, delete)
 *   - specs.publish / specs.deprecateVersion / specs.undeprecateVersion
 *       (publishing + deprecation lifecycle; `specs.saveDraft` stays member-level)
 *   - webhooks.upsertEndpoint / webhooks.deleteEndpoint
 *       (webhook endpoint config + signing-secret surface)
 *   - keySettings.setCap / keySettings.setDisabled / keySettings rotation state machine
 *       (gateway key provisioning, caps, rotation)
 *   - organizations.ensureOrganization stays identity-scoped (bootstrap/sync);
 *       any future org-level settings mutation should adopt this gate.
 *
 * Read-only queries and per-member mutations (draft save, wallet view, payout
 * state) intentionally stay at `requireOrgMemberBySlug` / `requireProjectMember`.
 */
export function requireOrgAdmin(claims: OrgIdentityClaims): OrgIdentityClaims {
  if (claims.orgRole !== "org:admin") {
    throw new Error("Org admin role required");
  }
  return claims;
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
