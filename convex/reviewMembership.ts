"use node";
import { createClerkClient } from "@clerk/backend";
import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
export const check = internalAction({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<void> => {
    const target = await ctx.runQuery(internal.reviews.membershipTarget, args);
    if (!process.env.CLERK_SECRET_KEY)
      throw new ConvexError(
        "Review eligibility could not be verified. Try again later.",
      );
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    let offset = 0;
    // Clerk remains membership authority, including memberships outside active org.
    for (;;) {
      const page = await clerk.users.getOrganizationMembershipList({
        userId: target.userId,
        limit: 100,
        offset,
      });
      if (page.data.some((m) => m.organization.id === target.publisherOrgId))
        throw new ConvexError(
          "Publisher organizations cannot review their own listing",
        );
      offset += page.data.length;
      if (!page.data.length || offset >= page.totalCount) return;
    }
  },
});
