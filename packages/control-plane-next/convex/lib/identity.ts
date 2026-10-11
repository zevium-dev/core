import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { isValidSlug, sha256Hex } from "@zevium/shared";
export async function getOrganization(
  ctx: Pick<QueryCtx, "db">,
  clerkOrgId: string,
) {
  return ctx.db
    .query("organizations")
    .withIndex("by_clerk", (q) => q.eq("clerkOrgId", clerkOrgId))
    .unique();
}
export async function isActive(
  ctx: Pick<QueryCtx, "db">,
  org: Doc<"organizations">,
) {
  return (
    org.archivedAt === undefined &&
    !(await ctx.db
      .query("orgTombstones")
      .withIndex("by_clerk", (q) => q.eq("clerkOrgId", org.clerkOrgId))
      .unique())
  );
}
export function trustedSlug(slug: string | undefined) {
  if (!slug || !isValidSlug(slug) || slug.length > 120)
    throw new ConvexError("Organization slug is unavailable");
  return slug;
}
export async function handleAvailable(
  ctx: Pick<QueryCtx, "db">,
  handle: string,
  own?: string,
) {
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_handle", (q) => q.eq("publicHandle", handle))
    .unique();
  const tomb = await ctx.db
    .query("orgTombstones")
    .withIndex("by_handle", (q) => q.eq("publisherHandle", handle))
    .unique();
  return !tomb && (!org || org.clerkOrgId === own);
}
export async function availableHandle(
  ctx: Pick<QueryCtx, "db">,
  slug: string,
  id: string,
) {
  if (await handleAvailable(ctx, slug, id)) return slug;
  const fallback = `${slug.slice(0, 60)}-${(await sha256Hex(id)).slice(0, 32)}`;
  if (!(await handleAvailable(ctx, fallback, id)))
    throw new ConvexError("Public handle unavailable");
  return fallback;
}
/** Only signed organization.created.created_by establishes the first processed creator claim.
 * PR 3 adds the promo ledger/lot and users.signupGrant in the same transaction.
 * Retained user identity prevents later organizations or deleted mirrors from claiming again.
 */
export async function claimSignupOrganization(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  userId: string,
) {
  if (!userId.trim() || !(await isActive(ctx, org))) return false;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", userId))
    .unique();
  if (user?.deletedAt !== undefined) return false;
  if (
    (org.personalForClerkUserId && org.personalForClerkUserId !== userId) ||
    (user?.signupPersonalOrganizationId &&
      user.signupPersonalOrganizationId !== org._id) ||
    (user?.signupGrant && user.signupGrant.organizationId !== org._id)
  )
    return false;
  const claimed = await ctx.db
    .query("organizations")
    .withIndex("by_personal_user", (q) =>
      q.eq("personalForClerkUserId", userId),
    )
    .unique();
  if (claimed && claimed._id !== org._id) return false;
  await ctx.db.patch(org._id, { personalForClerkUserId: userId });
  if (user)
    await ctx.db.patch(user._id, { signupPersonalOrganizationId: org._id });
  else
    await ctx.db.insert("users", {
      clerkUserId: userId,
      lastClerkEventAt: 0,
      signupPersonalOrganizationId: org._id,
    });
  return true;
}

/** PR 3 calls this inside its grant transaction, then writes signupGrant and ledger/lot atomically. */
export async function signupGrantCandidate(
  ctx: Pick<QueryCtx, "db">,
  clerkUserId: string,
) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk", (q) => q.eq("clerkUserId", clerkUserId))
    .unique();
  if (
    !user ||
    user.deletedAt !== undefined ||
    user.signupGrant ||
    !user.signupPersonalOrganizationId
  )
    return null;
  const org = await ctx.db.get(user.signupPersonalOrganizationId);
  if (
    !org ||
    org.personalForClerkUserId !== clerkUserId ||
    !(await isActive(ctx, org))
  )
    return null;
  return {
    userId: user._id,
    organizationId: org._id,
    clerkUserId,
    refId: `signup:${clerkUserId}`,
    credits: 10_000 as const,
  };
}
