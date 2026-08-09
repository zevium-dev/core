import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

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

/** Remove Clerk's personal-data mirror. Safe for webhook retries. */
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args): Promise<void> => {
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
