"use node";

import { createClerkClient } from "@clerk/backend";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const PAGE_SIZE = 25;

/** Clerk is membership truth; only verified primary emails receive org data. */
export const deliverPage = internalAction({
  args: {
    notificationId: v.id("notifications"),
    revision: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.EMAIL_FROM?.trim())
      return;
    const current = await ctx.runQuery(internal.notificationEmail.page, args);
    if (!current) return;
    try {
      const secretKey = process.env.CLERK_SECRET_KEY;
      if (!secretKey) throw new Error("Recipient lookup not configured");
      const clerk = createClerkClient({ secretKey });
      const members = await clerk.organizations.getOrganizationMembershipList({
        organizationId: current.notification.clerkOrgId,
        limit: PAGE_SIZE,
        offset: args.offset,
      });
      for (const member of members.data) {
        const userId = member.publicUserData?.userId;
        if (!userId) continue;
        const user = await clerk.users.getUser(userId);
        const email = user.emailAddresses.find(
          (address) => address.id === user.primaryEmailAddressId,
        );
        if (email?.verification?.status !== "verified") continue;
        await ctx.runMutation(internal.notificationEmail.enqueueRecipient, {
          ...args,
          clerkUserId: userId,
          email: email.emailAddress,
        });
      }
      const nextOffset = args.offset + members.data.length;
      // Treat an empty page as the end even if Clerk's count changed meanwhile.
      await ctx.runMutation(internal.notificationEmail.completePage, {
        ...args,
        nextOffset:
          members.data.length > 0 && nextOffset < members.totalCount
            ? nextOffset
            : null,
      });
    } catch {
      // Provider errors may contain email addresses/secrets. Watchdog owns retry.
      console.warn("Notification email page failed; retry scheduled", {
        notificationId: args.notificationId,
      });
    }
  },
});
