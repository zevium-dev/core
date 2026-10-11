import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { createNotification } from "./lib/notifications";
import { isActive } from "./lib/identity";
export const lowBalance = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<void> => {
    const rows = await ctx.db
      .query("wallets")
      .withIndex("by_balance", (q) => q.lt("balance", 1000))
      .paginate({ cursor: args.cursor, numItems: 50, maximumRowsRead: 51 });
    for (const w of rows.page) {
      const org = await ctx.db.get(w.owner.organizationId);
      if (!org || !(await isActive(ctx, org))) continue;
      await createNotification(ctx, {
        organizationId: org._id,
        kind: "low_balance",
        title: "Wallet balance is low",
        body: `${w.balance} credits remain. Add credits to keep calls running.`,
        refId: `low_balance:${w._id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
    if (!rows.isDone)
      await ctx.scheduler.runAfter(0, internal.cronTasks.lowBalance, {
        cursor: rows.continueCursor,
      });
  },
});
