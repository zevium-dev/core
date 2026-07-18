/** Credits are integer units; $1 is 10,000 credits. */
export const CREDITS_PER_USD = 10_000;

/** The platform retains exactly five percent, rounded down in credits. */
export const PLATFORM_FEE_BASIS_POINTS = 500;
export const BASIS_POINTS_DENOMINATOR = 10_000;

/** Earnings remain unavailable while payment fraud/refund risk matures. */
export const PUBLISHER_RISK_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

export type PublisherEarningSplit = {
  grossCredits: number;
  platformFeeCredits: number;
  publisherNetCredits: number;
};

/**
 * Canonical 95/5 integer split. The fee is floored, so the publisher receives
 * the remainder and gross always equals fee plus net.
 */
export function publisherEarningSplit(
  grossCredits: number,
): PublisherEarningSplit {
  if (!Number.isSafeInteger(grossCredits) || grossCredits < 0) {
    throw new Error("Gross credits must be a non-negative safe integer");
  }
  const platformFeeCredits = Math.floor(
    (grossCredits * PLATFORM_FEE_BASIS_POINTS) / BASIS_POINTS_DENOMINATOR,
  );
  return {
    grossCredits,
    platformFeeCredits,
    publisherNetCredits: grossCredits - platformFeeCredits,
  };
}

/** Stripe amounts are cents; never round credits up when transferring. */
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  return Math.floor((credits * 100) / CREDITS_PER_USD);
}
