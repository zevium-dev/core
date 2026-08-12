import { describe, expect, it } from "vitest";
import {
  BASIS_POINTS_DENOMINATOR,
  CREDITS_PER_USD,
  PLATFORM_FEE_BASIS_POINTS,
  creditsToUsdCents,
  publisherEarningSplit,
} from "./accounting";

describe("integer accounting boundaries", () => {
  it("keeps the 95/5 split exact at Number.MAX_SAFE_INTEGER", () => {
    const gross = Number.MAX_SAFE_INTEGER;
    const exactFee = Number(
      (BigInt(gross) * BigInt(PLATFORM_FEE_BASIS_POINTS) +
        BigInt(BASIS_POINTS_DENOMINATOR - 1)) /
        BigInt(BASIS_POINTS_DENOMINATOR),
    );
    const split = publisherEarningSplit(gross);

    expect(split.platformFeeCredits).toBe(exactFee);
    expect(split.publisherNetCredits + split.platformFeeCredits).toBe(gross);
  });

  it("converts maximum safe credits to cents without unsafe multiplication", () => {
    const credits = Number.MAX_SAFE_INTEGER;
    const exactCents = Number(
      (BigInt(credits) * 100n) / BigInt(CREDITS_PER_USD),
    );
    expect(creditsToUsdCents(credits)).toBe(exactCents);
  });
});
