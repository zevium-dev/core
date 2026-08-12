import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getOrgByClerkId,
  getOrgByPublicHandle,
  requireIdentity,
  requireOrgAdmin,
} from "./lib/auth";
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
    const org = await getOrgByPublicHandle(ctx, args.handle);
    if (org === null || org.publicHandle === undefined) {
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
    const current = await getOrgByClerkId(ctx, claims.orgId);
    if (current === null) {
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
    const org = await getOrgByClerkId(ctx, claims.orgId);
    if (org === null || org.publicHandle === undefined) {
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
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId, cursor: null },
      );
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
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
    return existing._id;
  },
});

/**
 * Atomic Svix receipt + ordered organization mirror write. A transaction error
 * rolls the receipt back, so provider retry never strands an unprocessed event.
 */
export const applyOrganizationWebhook = internalMutation({
  args: {
    svixId: v.string(),
    eventTimestamp: v.number(),
    eventType: v.union(
      v.literal("organization.created"),
      v.literal("organization.updated"),
      v.literal("organization.deleted"),
    ),
    clerkOrgId: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (
      args.svixId.trim() === "" ||
      !Number.isSafeInteger(args.eventTimestamp) ||
      args.eventTimestamp <= 0
    ) {
      throw new Error("Invalid Clerk webhook envelope");
    }
    const priorReceipt = await ctx.db
      .query("clerkWebhookReceipts")
      .withIndex("by_svix_id", (q) => q.eq("svixId", args.svixId))
      .unique();
    if (priorReceipt !== null) {
      return { status: "duplicate" as const };
    }
    const now = Date.now();
    const receiptId = await ctx.db.insert("clerkWebhookReceipts", {
      svixId: args.svixId,
      eventType: args.eventType,
      eventTimestamp: args.eventTimestamp,
      status: "processing",
      attempts: 1,
      lastAttemptAt: now,
      receivedAt: now,
    });
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (args.eventType === "organization.deleted") {
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
      if (existing !== null && existing.archivedAt === undefined) {
        await ctx.db.patch(existing._id, {
          archivedAt: now,
          lastClerkEventAt: Math.max(
            existing.lastClerkEventAt ?? 0,
            args.eventTimestamp,
          ),
        });
      }
      if (existing !== null) {
        await ctx.scheduler.runAfter(
          0,
          internal.catalogue.syncOrganizationCataloguePage,
          { organizationId: existing._id, cursor: null },
        );
      }
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.disableArchivedOrgKeysPage,
        { clerkOrgId: args.clerkOrgId, cursor: null },
      );
      await ctx.db.patch(receiptId, {
        status: "processed",
        processedAt: now,
      });
      return { status: "processed" as const };
    }

    if (args.name === undefined || args.slug === undefined) {
      throw new Error("Clerk organization payload is incomplete");
    }
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (
      tombstone !== null ||
      existing?.archivedAt !== undefined ||
      (existing?.lastClerkEventAt !== undefined &&
        args.eventTimestamp < existing.lastClerkEventAt)
    ) {
      await ctx.db.patch(receiptId, {
        status: "ignored_stale",
        processedAt: now,
      });
      return { status: "ignored_stale" as const };
    }

    if (existing === null) {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug: args.slug,
        publicHandle: args.slug,
        imageUrl: args.imageUrl,
        lastClerkEventAt: args.eventTimestamp,
        unreadNotificationCount: 0,
      });
      await ensureWallet(ctx, organizationId);
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId, cursor: null },
      );
    } else {
      await ctx.db.patch(existing._id, {
        name: args.name,
        slug: args.slug,
        ...(existing.publicHandle === undefined
          ? { publicHandle: args.slug }
          : {}),
        imageUrl: args.imageUrl,
        lastClerkEventAt: args.eventTimestamp,
      });
      await ensureWallet(ctx, existing._id);
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId: existing._id, cursor: null },
      );
    }
    await ctx.db.patch(receiptId, {
      status: "processed",
      processedAt: now,
    });
    return { status: "processed" as const };
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
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
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

    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (tombstone !== null) {
      throw new Error("Organization is archived");
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();

    if (existing === null) {
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
    const organization = await getOrgByClerkId(ctx, claims.orgId);
    if (!organization) throw new Error("Organization not found");
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
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: organization._id, cursor: null },
    );
    const updated = await ctx.db.get(organization._id);
    if (!updated) throw new Error("Organization not found");
    return updated;
  },
});

/** One-shot migration before publicHandle becomes required. */
export const backfillPublicHandles = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    args,
  ): Promise<{ updated: number; collisions: number }> => {
    const page = await ctx.db.query("organizations").paginate({
      cursor: args.cursor ?? null,
      numItems: 100,
      maximumRowsRead: 101,
    });
    let updated = 0;
    let collisions = 0;
    for (const organization of page.page) {
      if (organization.publicHandle !== undefined) continue;
      const normalized = organization.slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const base = normalized || "publisher";
      let handle = base;
      const taken = await ctx.db
        .query("organizations")
        .withIndex("by_public_handle", (q) => q.eq("publicHandle", handle))
        .unique();
      if (taken !== null) {
        collisions += 1;
        handle = `${base}-${organization._id
          .slice(-10)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")}`;
      }
      await ctx.db.patch(organization._id, { publicHandle: handle });
      updated += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.organizations.backfillPublicHandles,
        { cursor: page.continueCursor },
      );
    }
    return { updated, collisions };
  },
});
