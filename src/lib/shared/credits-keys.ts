/**
 * Centralized Redis key generators for credit-related operations.
 * All credit-related Redis keys should be defined here for consistency and maintainability.
 *
 * This module is intentionally kept separate from server-only code so it can be
 * safely imported in route files without pulling in database/redis dependencies.
 */
export const CreditsRedisKey = {
  /**
   * Key for storing user credit balance.
   * Set by: CreditsManager.add() and CreditsManager.deduct()
   * Read by: CreditsManager.getBalance()
   */
  balance: (userId: string) => `credits:balance:${userId}`,

  /**
   * Key for tracking if credits have been applied for a Polar checkout/order.
   * Set by: src/routes/api/polar/$.ts (webhook handler) when order.paid event is processed
   * Read by: src/routes/app/settings/credits/success.tsx (polling for credit application)
   * TTL: 1 year (365 days)
   */
  creditApplied: ({ checkoutId, userId }: { checkoutId: string; userId: string }) =>
    `polar:credit_applied:${userId}:${checkoutId}`,

  /**
   * Stream containing all credit ledger events (topups/deductions/adjustments).
   * Written by: CreditsManager.add() and CreditsManager.deduct()
   * Read by: /api/credits/flush (cron-triggered batch writer)
   */
  ledgerStream: () => "credits:ledger:stream",

  /**
   * Cursor tracking the last flushed Redis Stream id.
   * Used by: /api/credits/flush
   */
  ledgerStreamCursor: () => "credits:ledger:cursor",
};
