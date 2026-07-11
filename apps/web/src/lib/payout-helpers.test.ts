import { describe, expect, it } from "vitest";

import {
  MIN_PAYOUT_CREDITS,
  payoutStatusLabel,
  payoutStatusVariant,
  validatePayoutAmount,
} from "./payout-helpers";

describe("validatePayoutAmount", () => {
  const redeemable = 500_000;

  it("accepts a valid amount within redeemable balance", () => {
    expect(validatePayoutAmount(MIN_PAYOUT_CREDITS, redeemable)).toBeNull();
    expect(validatePayoutAmount(redeemable, redeemable)).toBeNull();
  });

  it("rejects non-integer amounts", () => {
    expect(validatePayoutAmount(100_000.5, redeemable)).toMatch(/whole number/);
    expect(validatePayoutAmount(Number.NaN, redeemable)).toMatch(
      /whole number/,
    );
  });

  it("rejects zero and negative amounts", () => {
    expect(validatePayoutAmount(0, redeemable)).toMatch(/greater than zero/);
    expect(validatePayoutAmount(-100, redeemable)).toMatch(/greater than zero/);
  });

  it("rejects amounts below the minimum", () => {
    expect(validatePayoutAmount(MIN_PAYOUT_CREDITS - 1, redeemable)).toMatch(
      /Minimum payout is 100,000 credits \(\$10\)/,
    );
  });

  it("rejects amounts above redeemable balance", () => {
    expect(validatePayoutAmount(redeemable + 1, redeemable)).toMatch(
      /exceeds your redeemable balance/,
    );
  });
});

describe("payoutStatusLabel / payoutStatusVariant", () => {
  it("maps pending", () => {
    expect(payoutStatusLabel("pending")).toBe("Pending");
    expect(payoutStatusVariant("pending")).toBe("outline");
  });

  it("maps paid", () => {
    expect(payoutStatusLabel("paid")).toBe("Paid");
    expect(payoutStatusVariant("paid")).toBe("secondary");
  });

  it("maps rejected", () => {
    expect(payoutStatusLabel("rejected")).toBe("Rejected");
    expect(payoutStatusVariant("rejected")).toBe("destructive");
  });
});
