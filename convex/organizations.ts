import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./lib/auth";

async function ensureWallet(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Id<"wallets">> {
  const existing = await ctx.db
    .query("wallets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (existing !== null) {
    return existing._id;
  }
  return await ctx.db.insert("wallets", {
    organizationId,
    balance: 0,
  });
}

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations"> | null> => {
    return await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx): Promise<Doc<"organizations">[]> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) {
      return [];
    }
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    return org === null ? [] : [org];
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"organizations">> => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (existing === null) {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug: args.slug,
        imageUrl: args.imageUrl,
      });
      await ensureWallet(ctx, organizationId);
      return organizationId;
    }

    await ctx.db.patch(existing._id, {
      name: args.name,
      slug: args.slug,
      imageUrl: args.imageUrl,
    });
    await ensureWallet(ctx, existing._id);
    return existing._id;
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (existing === null) {
      return;
    }

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) => q.eq("organizationId", existing._id))
      .unique();
    if (wallet !== null) {
      const entries = await ctx.db
        .query("walletEntries")
        .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
        .collect();
      for (const entry of entries) {
        await ctx.db.delete(entry._id);
      }
      await ctx.db.delete(wallet._id);
    }

    await ctx.db.delete(existing._id);
  },
});

/**
 * Called by web app with the active Clerk org.
 * Identity must be present; clerkOrgId must match a claim on the JWT
 * (org_id) so clients cannot invent orgs for other tenants.
 */
export const ensureOrganization = mutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Doc<"organizations">> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) {
      throw new Error("Organization does not match authenticated identity");
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (existing === null) {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug: args.slug,
        imageUrl: args.imageUrl,
      });
      await ensureWallet(ctx, organizationId);
      const created = await ctx.db.get(organizationId);
      if (created === null) {
        throw new Error("Failed to load created organization");
      }
      return created;
    }

    await ctx.db.patch(existing._id, {
      name: args.name,
      slug: args.slug,
      imageUrl: args.imageUrl,
    });
    await ensureWallet(ctx, existing._id);
    const updated = await ctx.db.get(existing._id);
    if (updated === null) {
      throw new Error("Failed to load updated organization");
    }
    return updated;
  },
});
