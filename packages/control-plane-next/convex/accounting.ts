/** Credits are integer units; $1 is 10,000 credits. */
export const CREDITS_PER_USD = 10_000;
export const CREDITS_PER_USD_CENT = CREDITS_PER_USD / 100;

/**
 * Accounting atoms preserve the 95/5 split without rounding either party.
 * One credit is divisible into one basis-point denominator worth of atoms.
 */
export const PLATFORM_FEE_BASIS_POINTS = 500;
export const BASIS_POINTS_DENOMINATOR = 10_000;
export const ACCOUNTING_ATOMS_PER_CREDIT = BASIS_POINTS_DENOMINATOR;
export const ACCOUNTING_ATOMS_PER_USD_CENT =
  CREDITS_PER_USD_CENT * ACCOUNTING_ATOMS_PER_CREDIT;
export const PUBLISHER_MINIMUM_PAYOUT_CENTS = 1_000;
export const PUBLISHER_MINIMUM_PAYOUT_ATOMS =
  PUBLISHER_MINIMUM_PAYOUT_CENTS * ACCOUNTING_ATOMS_PER_USD_CENT;

/** Earnings remain unavailable while payment fraud/refund risk matures. */
export const PUBLISHER_RISK_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

export type PublisherEarningSplit = {
  grossCredits: number;
  platformFeeAtoms: number;
  publisherNetAtoms: number;
  /** Decimal-credit display value. Atoms remain canonical. */
  platformFeeCredits: number;
  /** Decimal-credit display value. Atoms remain canonical. */
  publisherNetCredits: number;
};

/**
 * Canonical exact 95/5 split. All persisted settlement math uses atoms, so a
 * one-credit call creates 0.05 platform credits and 0.95 publisher credits.
 */
export function publisherEarningSplit(
  grossCredits: number,
): PublisherEarningSplit {
  if (!Number.isSafeInteger(grossCredits) || grossCredits < 0) {
    throw new Error("Gross credits must be a non-negative safe integer");
  }
  if (
    grossCredits >
    Math.floor(Number.MAX_SAFE_INTEGER / ACCOUNTING_ATOMS_PER_CREDIT)
  ) {
    throw new Error("Gross credits exceed the safe integer accounting range");
  }
  const platformFeeAtoms = grossCredits * PLATFORM_FEE_BASIS_POINTS;
  const publisherNetAtoms =
    grossCredits * (BASIS_POINTS_DENOMINATOR - PLATFORM_FEE_BASIS_POINTS);
  return {
    grossCredits,
    platformFeeAtoms,
    publisherNetAtoms,
    platformFeeCredits: atomsToCredits(platformFeeAtoms),
    publisherNetCredits: atomsToCredits(publisherNetAtoms),
  };
}

export function creditsToAtoms(credits: number): number {
  if (
    !Number.isSafeInteger(credits) ||
    credits < 0 ||
    credits > Math.floor(Number.MAX_SAFE_INTEGER / ACCOUNTING_ATOMS_PER_CREDIT)
  ) {
    throw new Error("Credits must be a non-negative safe accounting integer");
  }
  return credits * ACCOUNTING_ATOMS_PER_CREDIT;
}

export function atomsToCredits(atoms: number): number {
  if (!Number.isSafeInteger(atoms)) {
    throw new Error("Accounting atoms must be a safe integer");
  }
  return atoms / ACCOUNTING_ATOMS_PER_CREDIT;
}

/** Stripe amounts are cents; fractional cents stay in the publisher balance. */
export function atomsToUsdCents(atoms: number): number {
  if (!Number.isSafeInteger(atoms) || atoms < 0) {
    throw new Error("Accounting atoms must be a non-negative safe integer");
  }
  return Math.floor(atoms / ACCOUNTING_ATOMS_PER_USD_CENT);
}

/** Stripe amounts are cents; never round credits up when transferring. */
export function creditsToUsdCents(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new Error("Credits must be a non-negative safe integer");
  }
  return atomsToUsdCents(creditsToAtoms(credits));
}
