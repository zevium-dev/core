/**
 * Publisher payout helpers: client-side mirror of convex/payouts.ts
 * validation copy + status display mapping. Server (convex/payouts.ts,
 * convex/admin.ts) remains the authority — these run first for snappy
 * form feedback, but every mutation re-validates.
 */

/** Minimum redeemable payout. Must mirror convex/payouts.ts MIN_PAYOUT_CREDITS. */
export const MIN_PAYOUT_CREDITS = 100_000;

export type PayoutStatus = "pending" | "paid" | "rejected";

/**
 * Client-side precheck for a payout request amount. Returns a human error
 * string when invalid, or null when the amount is requestable.
 */
export function validatePayoutAmount(
  credits: number,
  redeemable: number,
): string | null {
  if (!Number.isFinite(credits) || !Number.isInteger(credits)) {
    return "Enter a whole number of credits.";
  }
  if (credits <= 0) {
    return "Enter an amount greater than zero.";
  }
  if (credits < MIN_PAYOUT_CREDITS) {
    return `Minimum payout is ${MIN_PAYOUT_CREDITS.toLocaleString()} credits ($10).`;
  }
  if (credits > redeemable) {
    return "Amount exceeds your redeemable balance.";
  }
  return null;
}

/** Human label for a payout request status. */
export function payoutStatusLabel(status: PayoutStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "paid":
      return "Paid";
    case "rejected":
      return "Rejected";
  }
}

/** Badge variant for a payout request status. */
export function payoutStatusVariant(
  status: PayoutStatus,
): "outline" | "secondary" | "destructive" {
  switch (status) {
    case "pending":
      return "outline";
    case "paid":
      return "secondary";
    case "rejected":
      return "destructive";
  }
}
