import { mutation } from "./_generated/server";
import { requireIdentity } from "./lib/auth";

const IMPORT_WINDOW_MS = 60_000;
const IMPORTS_PER_WINDOW = 10;

/**
 * Acquire one org+member URL-import lease. Convex mutation serialization makes
 * the fixed-window counter atomic across web isolates.
 */
export const acquireLease = mutation({
  args: {},
  handler: async (ctx): Promise<{ remaining: number; resetsAt: number }> => {
    const claims = await requireIdentity(ctx);
    if (!claims.orgId || !claims.orgRole) {
      throw new Error("Select an organization before importing a spec");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("specImportRateLeases")
      .withIndex("by_principal", (q) =>
        q.eq("clerkOrgId", claims.orgId!).eq("userId", claims.subject),
      )
      .unique();

    if (existing === null) {
      const resetsAt = now + IMPORT_WINDOW_MS;
      await ctx.db.insert("specImportRateLeases", {
        clerkOrgId: claims.orgId,
        userId: claims.subject,
        windowStartedAt: now,
        count: 1,
        expiresAt: resetsAt,
      });
      return { remaining: IMPORTS_PER_WINDOW - 1, resetsAt };
    }

    if (existing.expiresAt <= now) {
      const resetsAt = now + IMPORT_WINDOW_MS;
      await ctx.db.patch(existing._id, {
        windowStartedAt: now,
        count: 1,
        expiresAt: resetsAt,
      });
      return { remaining: IMPORTS_PER_WINDOW - 1, resetsAt };
    }

    if (existing.count >= IMPORTS_PER_WINDOW) {
      throw new Error("Spec import rate limit exceeded. Try again later.");
    }

    const count = existing.count + 1;
    await ctx.db.patch(existing._id, { count });
    return {
      remaining: IMPORTS_PER_WINDOW - count,
      resetsAt: existing.expiresAt,
    };
  },
});
