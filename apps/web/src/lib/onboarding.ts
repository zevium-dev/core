/** Top-up step is done when org wallet balance is strictly positive. */
export function isTopUpDone(balance: number): boolean {
  return Number.isFinite(balance) && balance > 0;
}

export type OnboardingFlags = {
  hasKey: boolean;
  hasCall: boolean;
  hasTopUp: boolean;
};

/**
 * Derive checklist completion from live org state.
 * Key count / call count / wallet balance — never hardcode done:false for top-up.
 */
export function deriveOnboardingFlags(input: {
  keyCount: number;
  callsCycle: number;
  balance: number;
}): OnboardingFlags {
  return {
    hasKey: input.keyCount > 0,
    hasCall: input.callsCycle > 0,
    hasTopUp: isTopUpDone(input.balance),
  };
}

/**
 * Show the get-started card while any step is incomplete.
 * Keys still loading → hide to avoid a flash of false "create key".
 */
export function shouldShowOnboarding(input: {
  keysLoaded: boolean;
  flags: OnboardingFlags;
}): boolean {
  if (!input.keysLoaded) {
    return false;
  }
  const { hasKey, hasCall, hasTopUp } = input.flags;
  return !(hasKey && hasCall && hasTopUp);
}
