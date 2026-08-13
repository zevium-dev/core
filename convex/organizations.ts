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
  requireActiveOrg,
  requireIdentity,
  requireOrgAdmin,
} from "./lib/auth";
import { isValidSlug } from "./lib/validate";

import { enqueueOrgArchive, enqueueOrgPut } from "./registrySync";
import { availablePublicHandle } from "./lib/publicRoutes";

function trustedOrganizationSlug(raw: string | undefined): string {
  const slug = raw?.trim().toLowerCase();
  if (slug === undefined || !isValidSlug(slug)) {
    throw new Error("Authenticated organization slug is invalid");
  }
  return slug;
}

async function requireAvailableOrganizationSlug(
  ctx: MutationCtx,
  slug: string,
  organizationId?: Id<"organizations">,
): Promise<void> {
  const rows = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .take(2);
  if (rows.some((row) => row._id !== organizationId)) {
    throw new Error("Organization slug is already in use");
  }
}
import { assertFinanceMigrationAllowsRuntime } from "./lib/financeMigrationGate";

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

/** Auth-sensitive role projection consumed by role-shaped app routes. */
export const activeCapabilities = query({
  args: {},
  handler: async (ctx) => {
    const { access } = await requireActiveOrg(ctx);
    return access;
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
    await assertFinanceMigrationAllowsRuntime(ctx);
    const slug = trustedOrganizationSlug(args.slug);
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (tombstone !== null) {
      // Clerk events are not ordered. A delete tombstone permanently wins over
      // late create/update delivery and prevents tenant resurrection.
      if (existing !== null && existing.archivedAt !== tombstone.archivedAt) {
        await ctx.db.patch(existing._id, {
          archivedAt: tombstone.archivedAt,
        });
      }
      return existing?._id ?? null;
    }

    if (existing === null) {
      await requireAvailableOrganizationSlug(ctx, slug);
      const publicHandle = await availablePublicHandle(
        ctx,
        slug,
        args.clerkOrgId,
      );
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: args.clerkOrgId,
        name: args.name,
        slug,
        publicHandle,
        imageUrl: args.imageUrl,
      });
      await ensureWallet(ctx, organizationId);
      await ctx.scheduler.runAfter(
        0,
        internal.catalogue.syncOrganizationCataloguePage,
        { organizationId, cursor: null },
      );
      const created = await ctx.db.get(organizationId);
      if (created === null) throw new Error("Failed to load organization");
      await enqueueOrgPut(ctx, created);
      return organizationId;
    }

    if (existing.archivedAt !== undefined) {
      // A late/out-of-order update must never resurrect a Clerk-deleted org.
      return existing._id;
    }

    await requireAvailableOrganizationSlug(ctx, slug, existing._id);
    const publicHandle =
      existing.publicHandle ??
      (await availablePublicHandle(ctx, slug, args.clerkOrgId, existing._id));
    await ctx.db.patch(existing._id, {
      name: args.name,
      slug,
      ...(existing.publicHandle === undefined ? { publicHandle } : {}),
      imageUrl: args.imageUrl,
    });
    await ensureWallet(ctx, existing._id);
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
    const updated = await ctx.db.get(existing._id);
    if (updated === null) throw new Error("Failed to load organization");
    await enqueueOrgPut(ctx, updated);
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
          sourceRevision: 1,
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
      await enqueueOrgArchive(
        ctx,
        args.clerkOrgId,
        existing === null ? null : String(existing._id),
        existing?.archivedAt ?? now,
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
      const created = await ctx.db.get(organizationId);
      if (created === null) throw new Error("Failed to load organization");
      await enqueueOrgPut(ctx, created);
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
      const updated = await ctx.db.get(existing._id);
      if (updated === null) throw new Error("Failed to load organization");
      await enqueueOrgPut(ctx, updated);
    }
    await ctx.db.patch(receiptId, {
      status: "processed",
      processedAt: now,
    });
    return { status: "processed" as const };
  },
});

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

export const archiveFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const now = Date.now();
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (tombstone === null) {
      await ctx.db.insert("organizationTombstones", {
        sourceRevision: 1,
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
      await assertArchivable(ctx, existing._id);
      await ctx.db.patch(existing._id, { archivedAt: now });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.catalogue.syncOrganizationCataloguePage,
      { organizationId: existing._id, cursor: null },
    );
  },
});

/** Registry v2 alias: terminal org archive, delegates to archiveFromClerk. */
export const deleteFromClerk = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(internal.organizations.archiveFromClerk, {
      clerkOrgId: args.clerkOrgId,
    });
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    const tombstone = await ctx.db
      .query("organizationTombstones")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    await enqueueOrgArchive(
      ctx,
      args.clerkOrgId,
      existing === null ? null : String(existing._id),
      tombstone?.archivedAt ?? Date.now(),
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
    await assertFinanceMigrationAllowsRuntime(ctx);
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined || claims.orgId !== args.clerkOrgId) {
      throw new Error("Organization does not match authenticated identity");
    }
    trustedOrganizationSlug(claims.orgSlug);

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
      await enqueueOrgPut(ctx, created);
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
    if (organization.publicHandle === handle) return organization;
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
    await enqueueOrgPut(ctx, updated);
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
