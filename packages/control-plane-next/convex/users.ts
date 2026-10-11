import { mutation } from "./_generated/server";
import { ConvexError } from "convex/values";
import { requireIdentity } from "./lib/auth";
import { userDto } from "./lib/dto";
export const ensureUser = mutation({
  args: {},
  handler: async (ctx) => {
    const claims = await requireIdentity(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk", (q) => q.eq("clerkUserId", claims.subject))
      .unique();
    if (user?.deletedAt !== undefined)
      throw new ConvexError("Not authenticated");
    if (user) return userDto(user);
    const id = await ctx.db.insert("users", {
      clerkUserId: claims.subject,
      email: claims.email,
      lastClerkEventAt: 0,
    });
    return userDto((await ctx.db.get(id))!);
  },
});
