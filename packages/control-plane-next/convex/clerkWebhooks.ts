import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  availableHandle,
  claimSignupOrganization,
  getOrganization,
  trustedSlug,
} from "./lib/identity";
import { revokeKey } from "./lib/keys";
/** Receipt and mirror transition commit together; exceptions leave delivery retryable. */
export const apply = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    objectId: v.string(),
    sourceTimestamp: v.number(),
    fingerprint: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    creatorClerkUserId: v.optional(v.string()),
    clerkOrgId: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (
      !args.eventId ||
      !args.objectId ||
      !Number.isSafeInteger(args.sourceTimestamp) ||
      args.sourceTimestamp <= 0
    )
      throw new ConvexError("Invalid Clerk event");
    const previous = await ctx.db
      .query("webhookReceipts")
      .withIndex("by_event", (q) =>
        q
          .eq("provider", "clerk")
          .eq("account", "instance")
          .eq("eventId", args.eventId),
      )
      .unique();
    if (previous) {
      if (previous.payloadHash !== args.fingerprint)
        throw new ConvexError("Clerk event conflicts with receipt");
      return { status: "duplicate" };
    }
    const now = Date.now();
    if (args.eventType.startsWith("organization.")) {
      let org = await getOrganization(ctx, args.objectId);
      const tomb = await ctx.db
        .query("orgTombstones")
        .withIndex("by_clerk", (q) => q.eq("clerkOrgId", args.objectId))
        .unique();
      if (args.eventType === "organization.deleted") {
        // A signed delete is terminal even when it arrives before creation. Finance stays intact.
        if (!tomb)
          await ctx.db.insert("orgTombstones", {
            clerkOrgId: args.objectId,
            organizationId: org?._id,
            publisherHandle: org?.publicHandle,
            sourceTimestamp: args.sourceTimestamp,
            archivedAt: now,
          });
        if (org && org.archivedAt === undefined) {
          await ctx.db.patch(org._id, {
            archivedAt: now,
            revision: org.revision + 1,
            lastClerkEventAt: Math.max(
              org.lastClerkEventAt,
              args.sourceTimestamp,
            ),
          });
          await ctx.scheduler.runAfter(0, internal.clerkWebhooks.archivePage, {
            organizationId: org._id,
            cursor: null,
            phase: "keys",
          });
        }
      } else if (!tomb && org?.archivedAt === undefined) {
        if (!org) {
          const slug = trustedSlug(args.slug);
          if (!args.name)
            throw new ConvexError("Incomplete Clerk organization");
          const id = await ctx.db.insert("organizations", {
            clerkOrgId: args.objectId,
            name: args.name,
            slug,
            publicHandle: await availableHandle(ctx, slug, args.objectId),
            imageUrl: args.imageUrl,
            lastClerkEventAt: args.sourceTimestamp,
            revision: 1,
          });
          org = (await ctx.db.get(id))!;
        } else if (args.sourceTimestamp > org.lastClerkEventAt) {
          if (!args.name)
            throw new ConvexError("Incomplete Clerk organization");
          await ctx.db.patch(org._id, {
            name: args.name,
            slug: trustedSlug(args.slug),
            imageUrl: args.imageUrl,
            lastClerkEventAt: args.sourceTimestamp,
            revision: org.revision + 1,
          });
        }
        // A delayed signed creation may claim eligibility without rewinding newer display fields.
        if (
          args.eventType === "organization.created" &&
          args.creatorClerkUserId
        )
          await claimSignupOrganization(ctx, org, args.creatorClerkUserId);
      }
    } else if (args.eventType.startsWith("user.")) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk", (q) => q.eq("clerkUserId", args.objectId))
        .unique();
      if (args.eventType === "user.deleted") {
        if (user)
          await ctx.db.patch(user._id, {
            name: undefined,
            email: undefined,
            deletedAt: user.deletedAt ?? now,
            lastClerkEventAt: Math.max(
              user.lastClerkEventAt,
              args.sourceTimestamp,
            ),
          });
        else
          await ctx.db.insert("users", {
            clerkUserId: args.objectId,
            deletedAt: now,
            lastClerkEventAt: args.sourceTimestamp,
          });
      } else if (!user)
        await ctx.db.insert("users", {
          clerkUserId: args.objectId,
          name: args.name,
          email: args.email,
          lastClerkEventAt: args.sourceTimestamp,
        });
      else if (
        user.deletedAt === undefined &&
        args.sourceTimestamp > user.lastClerkEventAt
      )
        await ctx.db.patch(user._id, {
          name: args.name,
          email: args.email,
          lastClerkEventAt: args.sourceTimestamp,
        });
    } else if (args.eventType === "organizationMembership.deleted") {
      if (!args.clerkOrgId || !args.userId)
        throw new ConvexError("Invalid membership event");
      const org = await getOrganization(ctx, args.clerkOrgId);
      if (org)
        await ctx.scheduler.runAfter(0, internal.clerkWebhooks.membershipPage, {
          organizationId: org._id,
          userId: args.userId,
          deletedAt: args.sourceTimestamp,
          cursor: null,
        });
    } else throw new ConvexError("Unsupported Clerk event");
    await ctx.db.insert("webhookReceipts", {
      provider: "clerk",
      account: "instance",
      eventId: args.eventId,
      eventType: args.eventType,
      objectId: args.objectId,
      sourceTimestamp: args.sourceTimestamp,
      receivedAt: now,
      state: "complete",
      attempts: 1,
      deliveries: 1,
      processedAt: now,
      payloadHash: args.fingerprint,
    });
    return { status: "processed" };
  },
});
export const membershipPage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    deletedAt: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("apiKeys")
      .withIndex("by_org_owner", (q) =>
        q
          .eq("kind", "key")
          .eq("organizationId", args.organizationId)
          .eq("ownerUserId", args.userId),
      )
      .paginate({ cursor: args.cursor, numItems: 50 });
    for (const row of page.page)
      if (row.kind === "key" && row.verifiedAt <= args.deletedAt)
        await revokeKey(ctx, row, args.deletedAt);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.clerkWebhooks.membershipPage, {
        ...args,
        cursor: page.continueCursor,
      });
  },
});
export const archivePage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    cursor: v.union(v.string(), v.null()),
    phase: v.union(v.literal("keys"), v.literal("projects")),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org || org.archivedAt === undefined) return;
    if (args.phase === "keys") {
      const page = await ctx.db
        .query("apiKeys")
        .withIndex("by_org", (q) =>
          q.eq("kind", "key").eq("organizationId", org._id),
        )
        .paginate({ cursor: args.cursor, numItems: 50 });
      for (const row of page.page)
        if (row.kind === "key") await revokeKey(ctx, row);
      await ctx.scheduler.runAfter(0, internal.clerkWebhooks.archivePage, {
        ...args,
        phase: page.isDone ? "projects" : "keys",
        cursor: page.isDone ? null : page.continueCursor,
      });
    } else {
      const page = await ctx.db
        .query("projects")
        .withIndex("by_org_slug", (q) => q.eq("organizationId", org._id))
        .paginate({ cursor: args.cursor, numItems: 50 });
      for (const project of page.page)
        await ctx.runMutation(internal.projects.retire, {
          projectId: project._id,
        });
      if (!page.isDone)
        await ctx.scheduler.runAfter(0, internal.clerkWebhooks.archivePage, {
          ...args,
          cursor: page.continueCursor,
        });
    }
  },
});
