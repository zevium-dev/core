import { CREDITS_PER_USD } from "../accounting";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Called only for signed organization.created; the first processed creator claim wins. */
export async function grantSignupCredit(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  creatorClerkUserId: string | undefined,
): Promise<void> {
  const organization = await ctx.db.get(organizationId);
  if (
    organization === null ||
    organization.archivedAt !== undefined ||
    organization.walletKind === "anonymous"
  )
    return;
  if (!creatorClerkUserId?.trim()) return;
  const deletedUser = await ctx.db
    .query("userTombstones")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", creatorClerkUserId))
    .unique();
  if (deletedUser !== null) return;
  const tombstone = await ctx.db
    .query("organizationTombstones")
    .withIndex("by_clerk_org", (q) =>
      q.eq("clerkOrgId", organization.clerkOrgId),
    )
    .unique();
  if (tombstone !== null) return;
  const priorOrgGrant = await ctx.db
    .query("signupCreditGrants")
    .withIndex("by_clerk_org", (q) =>
      q.eq("clerkOrgId", organization.clerkOrgId),
    )
    .unique();
  if (priorOrgGrant !== null) return;
  const priorCreatorGrant = await ctx.db
    .query("signupCreditGrants")
    .withIndex("by_creator", (q) =>
      q.eq("creatorClerkUserId", creatorClerkUserId),
    )
    .unique();
  if (priorCreatorGrant !== null) return;

  // The indexed creator claim and ledger/funding write share one transaction.
  // Existing grants remain consumed, including grants under the older policy.
  await ctx.runMutation(internal.wallets.applyAdminAdjustment, {
    organizationId,
    amount: CREDITS_PER_USD,
    refId: `promo:signup:${organization.clerkOrgId}`,
    promotion: true,
  });
  await ctx.db.insert("signupCreditGrants", {
    clerkOrgId: organization.clerkOrgId,
    creatorClerkUserId,
    organizationId,
    grantedAt: Date.now(),
  });
}
