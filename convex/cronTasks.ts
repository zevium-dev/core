import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { createNotification } from "./lib/notifications";

/** Wallet balance below this triggers a low-balance notification (credits). */
const LOW_BALANCE_THRESHOLD = 1000;

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Hourly cron: check all org wallets for low balance.
 * Fires one low_balance notification per org per UTC day (idempotent via refId).
 *
 * This is a background cron, not a hot path — wallets table is O(orgs).
 */
export const checkLowBalances = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ notified: number }> => {
    const now = Date.now();
    const utcDay = startOfUtcDay(now);
    const dayKey = new Date(utcDay).toISOString().slice(0, 10); // YYYY-MM-DD

    const page = await ctx.db.query("wallets").paginate({
      cursor: args.cursor ?? null,
      numItems: 25,
      maximumRowsRead: 50,
    });
    let notified = 0;

    for (const wallet of page.page) {
      if (wallet.balance >= LOW_BALANCE_THRESHOLD) continue;

      const org = await ctx.db.get(wallet.organizationId);
      if (org === null) continue;

      const refId = `low_balance:${org.clerkOrgId}:${dayKey}`;
      const result = await createNotification(ctx, {
        clerkOrgId: org.clerkOrgId,
        kind: "low_balance",
        title: "Low wallet balance",
        body: `Your wallet balance is ${wallet.balance} credits. Top up to avoid call interruptions.`,
        refId,
      });
      if (result.created) notified += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.cronTasks.checkLowBalances, {
        cursor: page.continueCursor,
      });
    }

    return { notified };
  },
});
