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
  const organization = await ctx.db.get(organizationId);
  if (organization?.archivedAt !== undefined) {
    throw new Error("Archived organization cannot receive a new wallet");
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

async function assertArchivable(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<void> {
  const migration = await ctx.db
    .query("financialMigrationJobs")
    .withIndex("by_migration_key", (q) =>
      q.eq("migrationKey", "finance-v2-universal-funding-v2"),
    )
    .unique();
  if (migration !== null && migration.status !== "verified") {
    throw new Error("Organization archive blocked by finance migration");
  }
  for (const status of ["pending", "disputed"] as const) {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organizationId),
      )
      .filter((q) => q.eq(q.field("status"), status))
      .take(1);
    if (payment.length > 0) {
      throw new Error("Organization archive blocked by unresolved payment");
    }
  }
  const disputes = await ctx.db
    .query("paymentDisputes")
    .withIndex("by_organization_status", (q) =>
      q.eq("organizationId", organizationId).eq("status", "needs_response"),
    )
    .take(1);
  if (disputes.length > 0) {
    throw new Error("Organization archive blocked by unresolved dispute");
  }
  const exposures = await ctx.db
    .query("paymentExposures")
    .withIndex("by_organization_active", (q) =>
      q.eq("organizationId", organizationId).eq("active", true),
    )
    .take(1);
  if (exposures.length > 0) {
    throw new Error("Organization archive blocked by unresolved exposure");
  }
  const reconciliation = await ctx.db
    .query("publisherReconciliationJobs")
    .withIndex("by_consumer_status", (q) =>
      q.eq("consumerOrganizationId", organizationId).eq("status", "pending"),
    )
    .take(1);
  if (reconciliation.length > 0) {
    throw new Error("Organization archive blocked by publisher reconciliation");
  }
  for (const status of ["created", "pending"] as const) {
    const transfer = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher_status", (q) =>
        q.eq("publisherOrganizationId", organizationId).eq("status", status),
      )
      .take(1);
    if (transfer.length > 0) {
      throw new Error("Organization archive blocked by unresolved transfer");
    }
  }
  const profile = await ctx.db
    .query("organizationPayments")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (profile?.stripeConnectedAccountId !== undefined) {
    const payouts = await ctx.db
      .query("connectedPayouts")
      .withIndex("by_connected_account_status", (q) =>
        q
          .eq("stripeConnectedAccountId", profile.stripeConnectedAccountId!)
          .eq("status", "pending"),
      )
      .take(1);
    if (payouts.length > 0) {
      throw new Error("Organization archive blocked by unresolved payout");
    }
  }
}

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations"> | null> => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    return organization?.archivedAt === undefined ? organization : null;
  },
});

export const getByPublicHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<Doc<"organizations"> | null> => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) =>
        q.eq("publicHandle", args.handle.trim().toLowerCase()),
      )
      .unique();
    return organization?.archivedAt === undefined ? organization : null;
  },
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
    return org === null || org.archivedAt !== undefined ? [] : [org];
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

    if (existing.archivedAt !== undefined) return;
    await assertArchivable(ctx, existing._id);
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
    if (existing.archivedAt !== undefined) {
      throw new Error("Organization is archived and cannot be reactivated");
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
