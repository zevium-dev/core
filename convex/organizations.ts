import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireOrgAdmin } from "./lib/auth";
import { isValidSlug } from "./lib/validate";

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
  const walletId = await ctx.db.insert("wallets", {
    organizationId,
    balance: 0,
    sequence: 0,
    debtCredits: 0,
  });
  await ctx.db.insert("walletFundingStates", {
    walletId,
    organizationId,
    nonrefundableAvailableCredits: 0,
    refundableAvailableCredits: 0,
    allocatedCredits: 0,
    reversedCredits: 0,
    sequence: 0,
    migrationStatus: "verified",
    migrationWatermarkSequence: 0,
    updatedAt: Date.now(),
  });
  return walletId;
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

export const getByPublicHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations"> | null> =>
    await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) =>
        q.eq("publicHandle", args.handle.trim().toLowerCase()),
      )
      .unique(),
});

/** Auth-scoped availability probe; never exposes another organization record. */
export const checkPublicHandleAvailability = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<{ available: boolean }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId) throw new Error("No active organization");
    const handle = args.handle.trim().toLowerCase();
    const current = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
      .unique();
    return { available: existing === null || existing._id === current?._id };
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
        publicHandle: args.slug,
        imageUrl: args.imageUrl,
      });
      await ensureWallet(ctx, organizationId);
      return organizationId;
    }

    await ctx.db.patch(existing._id, {
      name: args.name,
      slug: args.slug,
      ...(existing.publicHandle === undefined
        ? { publicHandle: args.slug }
        : {}),
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

    await ctx.db.patch(existing._id, {
      archivedAt: Date.now(),
    });
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
        publicHandle: args.slug,
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
      ...(existing.publicHandle === undefined
        ? { publicHandle: args.slug }
        : {}),
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

/** Update only the canonical public routing handle, never Clerk's slug. */
export const setPublicHandle = mutation({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations">> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (!claims.orgId) throw new Error("No active organization on identity");
    const handle = args.handle.trim().toLowerCase();
    if (!isValidSlug(handle)) {
      throw new Error("Public handle must be kebab-case");
    }
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (!organization) throw new Error("Organization not found");
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
      .unique();
    if (existing && existing._id !== organization._id) {
      throw new Error("That public handle is already in use");
    }
    await ctx.db.patch(organization._id, {
      publicHandle: handle,
    });
    const updated = await ctx.db.get(organization._id);
    if (!updated) throw new Error("Organization not found");
    return updated;
  },
});

/** One-shot migration before publicHandle becomes required. */
export const backfillPublicHandles = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ updated: number; collisions: number }> => {
    const organizations = await ctx.db.query("organizations").collect();
    const taken = new Set(
      organizations
        .map((organization) => organization.publicHandle)
        .filter((handle): handle is string => handle !== undefined),
    );
    let updated = 0;
    let collisions = 0;
    for (const organization of organizations) {
      if (organization.publicHandle !== undefined) continue;
      const base = organization.slug.trim().toLowerCase();
      let handle = base;
      if (taken.has(handle)) {
        collisions += 1;
        handle = `${base}-${organization._id.slice(-6).toLowerCase()}`;
      }
      taken.add(handle);
      await ctx.db.patch(organization._id, { publicHandle: handle });
      updated += 1;
    }
    return { updated, collisions };
  },
});
