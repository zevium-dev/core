import { describe, expect, it } from "vitest";

import {
  deriveOnboardingFlags,
  isTopUpDone,
  nextOnboardingStep,
  shouldShowOnboarding,
} from "./onboarding";

describe("isTopUpDone", () => {
  it("true only when balance > 0", () => {
    expect(isTopUpDone(0)).toBe(false);
    expect(isTopUpDone(-1)).toBe(false);
    expect(isTopUpDone(0.1)).toBe(true);
    expect(isTopUpDone(10_000)).toBe(true);
  });

  it("rejects non-finite", () => {
    expect(isTopUpDone(Number.NaN)).toBe(false);
    expect(isTopUpDone(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("nextOnboardingStep", () => {
  it("keeps key, top-up, live-call order regardless of later flags", () => {
    expect(
      nextOnboardingStep({ hasKey: false, hasTopUp: true, hasCall: true }),
    ).toBe("key");
    expect(
      nextOnboardingStep({ hasKey: true, hasTopUp: false, hasCall: true }),
    ).toBe("topup");
    expect(
      nextOnboardingStep({ hasKey: true, hasTopUp: true, hasCall: false }),
    ).toBe("call");
    expect(
      nextOnboardingStep({ hasKey: true, hasTopUp: true, hasCall: true }),
    ).toBeNull();
  });
});

describe("deriveOnboardingFlags", () => {
  it("maps counts and balance", () => {
    expect(
      deriveOnboardingFlags({ keyCount: 0, callsCycle: 0, balance: 0 }),
    ).toEqual({ hasKey: false, hasCall: false, hasTopUp: false });

    expect(
      deriveOnboardingFlags({ keyCount: 1, callsCycle: 3, balance: 500 }),
    ).toEqual({ hasKey: true, hasCall: true, hasTopUp: true });
  });
});

describe("shouldShowOnboarding", () => {
  it("hidden until keys loaded", () => {
    expect(
      shouldShowOnboarding({
        keysLoaded: false,
        flags: { hasKey: false, hasCall: false, hasTopUp: false },
      }),
    ).toBe(false);
  });

  it("shown while any step open", () => {
    expect(
      shouldShowOnboarding({
        keysLoaded: true,
        flags: { hasKey: true, hasCall: true, hasTopUp: false },
      }),
    ).toBe(true);
  });

  it("hidden when all done", () => {
    expect(
      shouldShowOnboarding({
        keysLoaded: true,
        flags: { hasKey: true, hasCall: true, hasTopUp: true },
      }),
    ).toBe(false);
  });
});
