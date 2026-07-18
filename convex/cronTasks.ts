import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
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
  args: {},
  handler: async (ctx): Promise<{ notified: number }> => {
    const now = Date.now();
    const utcDay = startOfUtcDay(now);
    const dayKey = new Date(utcDay).toISOString().slice(0, 10); // YYYY-MM-DD

    const wallets = await ctx.db.query("wallets").collect();
    let notified = 0;

    for (const wallet of wallets) {
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

    return { notified };
  },
});

/**
 * Returns the distinct set of publisher org ids that currently have earnings
 * sitting in the risk-hold window (status `pending_risk`). Uses the
 * `by_status_available` index so this stays cheap as the earnings table grows.
 *
 * Exposed as an internal query so the cron action can enumerate orgs without
 * touching ctx.db (unavailable inside an action) and without requiring admin
 * auth like admin.listOrgs does.
 */
export const listOrgsWithPendingEarnings = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"organizations">[]> => {
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_status_available", (q) => q.eq("status", "pending_risk"))
      .collect();
    const orgIds = new Set<Id<"organizations">>();
    for (const earning of pending) {
      orgIds.add(earning.publisherOrganizationId);
    }
    return [...orgIds];
  },
});

/**
 * Hourly cron: release risk-held earnings that have matured past their hold.
 *
 * `payouts.releaseMatureEarnings` is the per-org mutation that flips matured
 * `pending_risk` rows to `available`; without a cron it was only invoked
 * opportunistically from the transfer flow, so earnings with no active payout
 * attempt orphaned in `pending_risk` forever.
 *
 * This wrapper fans the release out across every org with pending earnings.
 * Each org runs in its own transaction via runMutation, so a failure for one
 * org (thrown validation, transient error, etc.) is caught, logged, and
 * skipped — it cannot poison the release for the remaining orgs.
 */
export const releaseMatureEarningsCron = internalAction({
  args: {},
  handler: async (ctx): Promise<{ released: number; failed: number }> => {
    const orgIds = await ctx.runQuery(
      internal.cronTasks.listOrgsWithPendingEarnings,
      {},
    );

    let released = 0;
    let failed = 0;
    for (const orgId of orgIds) {
      try {
        await ctx.runMutation(internal.payouts.releaseMatureEarnings, {
          publisherOrganizationId: orgId,
        });
        released += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[releaseMatureEarningsCron] release failed for org ${orgId}`,
          err,
        );
      }
    }

    return { released, failed };
  },
});
