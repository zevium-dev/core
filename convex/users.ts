import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { grantSignupCredit } from "./lib/signupCredit";

export const upsertFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"users">> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (existing === null) {
      return await ctx.db.insert("users", {
        clerkUserId: args.clerkUserId,
        name: args.name,
        email: args.email,
      });
    }

    await ctx.db.patch(existing._id, {
      name: args.name,
      email: args.email,
    });
    return existing._id;
  },
});

/** Only /clerk-webhook user.created supplies this frozen signup snapshot. */
export const recordSignupFromClerk = internalMutation({
  args: {
    clerkUserId: v.string(),
    personalOrganization: v.optional(
      v.object({
        clerkOrgId: v.string(),
        createdAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    if (!args.clerkUserId.trim()) throw new Error("Invalid Clerk user ID");
    const personal = args.personalOrganization;
    if (
      personal !== undefined &&
      (!personal.clerkOrgId.trim() ||
        !Number.isSafeInteger(personal.createdAt) ||
        personal.createdAt <= 0)
    )
      throw new Error("Invalid Clerk signup organization");
    const existing = await ctx.db
      .query("signupCreditEligibility")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    // Empty or ambiguous signup snapshots are final too. Later organizations,
    // user.updated events, and replays cannot turn them into eligible signups.
    if (existing !== null) return;
    await ctx.db.insert("signupCreditEligibility", {
      clerkUserId: args.clerkUserId,
      clerkOrgId: personal?.clerkOrgId,
      organizationCreatedAt: personal?.createdAt,
      recordedAt: Date.now(),
    });
    if (personal === undefined) return;
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", personal.clerkOrgId))
      .unique();
    if (organization !== null) await grantSignupCredit(ctx, organization._id);
  },
});

/** Remove Clerk's personal-data mirror. Safe for webhook retries. */
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const eligibility = await ctx.db
      .query("signupCreditEligibility")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
    if (eligibility === null) {
      await ctx.db.insert("signupCreditEligibility", {
        clerkUserId: args.clerkUserId,
        recordedAt: Date.now(),
        deletedAt: Date.now(),
      });
    } else if (eligibility.deletedAt === undefined) {
      await ctx.db.patch(eligibility._id, { deletedAt: Date.now() });
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Mirror the authenticated Clerk identity into the users table.
 * Safe to call on every app boot; returns the canonical row.
 */
export const ensureUser = mutation({
  args: {},
  handler: async (ctx): Promise<Doc<"users">> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not authenticated");
    }

    const clerkUserId = identity.subject;
    const joinedName = [identity.givenName, identity.familyName]
      .filter(Boolean)
      .join(" ");
    const name =
      identity.name ||
      joinedName ||
      identity.nickname ||
      identity.email ||
      "User";
    const email = identity.email ?? "";

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (existing === null) {
      const userId = await ctx.db.insert("users", {
        clerkUserId,
        name,
        email,
      });
      const created = await ctx.db.get(userId);
      if (created === null) {
        throw new Error("Failed to load created user");
      }
      return created;
    }

    await ctx.db.patch(existing._id, { name, email });
    const updated = await ctx.db.get(existing._id);
    if (updated === null) {
      throw new Error("Failed to load updated user");
    }
    return updated;
  },
});
