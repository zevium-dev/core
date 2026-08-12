import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
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
  return await ctx.db.insert("wallets", {
    organizationId,
    balance: 0,
    sequence: 0,
  });
}

export type PublicOrganization = {
  name: string;
  publisherHandle: string;
  imageUrl: string | undefined;
};

export type MineOrganization = PublicOrganization & {
  publicHandleLocked: boolean;
};

export const getByPublicHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, args): Promise<PublicOrganization | null> => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) =>
        q.eq("publicHandle", args.handle.trim().toLowerCase()),
      )
      .unique();
    if (
      org === null ||
      org.archivedAt !== undefined ||
      org.publicHandle === undefined
    ) {
      return null;
    }
    return {
      name: org.name,
      publisherHandle: org.publicHandle,
      imageUrl: org.imageUrl,
    };
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
    if (current?.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
      .unique();
    return { available: existing === null || existing._id === current?._id };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx): Promise<MineOrganization[]> => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined) {
      return [];
    }
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (
      org === null ||
      org.archivedAt !== undefined ||
      org.publicHandle === undefined
    ) {
      return [];
    }
    const publishedProject = await ctx.db
      .query("projects")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", org._id).eq("status", "published"),
      )
      .first();
    return [
      {
        name: org.name,
        publisherHandle: org.publicHandle,
        imageUrl: org.imageUrl,
        publicHandleLocked: publishedProject !== null,
      },
    ];
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"organizations"> | null> => {
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (tombstone !== null) {
      // Clerk events are not ordered. A delete tombstone permanently wins over
      // late create/update delivery and prevents tenant resurrection.
      return existing?._id ?? null;
    }

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

    if (existing.archivedAt !== undefined) {
      // A late/out-of-order update must never resurrect a Clerk-deleted org.
      return existing._id;
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

export const archiveFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (tombstone === null) {
      await ctx.db.insert("organizationTombstones", {
        clerkOrgId: args.clerkOrgId,
        archivedAt: now,
      });
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    await ctx.scheduler.runAfter(
      0,
      internal.organizations.disableArchivedOrgKeysPage,
      { clerkOrgId: args.clerkOrgId, cursor: null },
    );
    if (existing === null) {
      return;
    }

    if (existing.archivedAt === undefined) {
      await ctx.db.patch(existing._id, { archivedAt: now });
    }
  },
});

/** Bounded continuation job; safe under retries and concurrent archive events. */
export const disableArchivedOrgKeysPage = internalMutation({
  args: {
    clerkOrgId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ disabled: number; done: boolean }> => {
    const page = await ctx.db
      .query("keySettings")
      .withIndex("by_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .paginate({ cursor: args.cursor, numItems: 100 });
    const now = Date.now();
    for (const setting of page.page) {
      if (setting.disabled) continue;
      await ctx.db.patch(setting._id, {
        disabled: true,
        updatedAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.disableArchivedOrgKeysPage,
        { clerkOrgId: args.clerkOrgId, cursor: page.continueCursor },
      );
    }
    return { disabled: page.page.length, done: page.isDone };
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
      const tombstone = await ctx.db
        .query("organizationTombstones")
        .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
        .unique();
      if (tombstone !== null) {
        throw new Error("Organization is archived");
      }
      const signedSlug = claims.orgSlug?.trim().toLowerCase();
      if (signedSlug === undefined || !isValidSlug(signedSlug)) {
        throw new Error(
          "Active organization is awaiting Clerk synchronization",
        );
      }
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: signedSlug,
        slug: signedSlug,
        publicHandle: signedSlug,
      });
      await ensureWallet(ctx, organizationId);
      const created = await ctx.db.get(organizationId);
      if (created === null) {
        throw new Error("Failed to load created organization");
      }
      return created;
    }
    if (existing.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    await ensureWallet(ctx, existing._id);
    return existing;
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
    if (organization.archivedAt !== undefined) {
      throw new Error("Organization is archived");
    }
    if (organization.publicHandle === handle) return organization;
    const publishedProject = await ctx.db
      .query("projects")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", organization._id).eq("status", "published"),
      )
      .first();
    if (publishedProject !== null) {
      throw new Error("Public handle is permanent after first publication");
    }
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
