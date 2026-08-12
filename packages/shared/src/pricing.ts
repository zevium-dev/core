/** Hard economic boundary: no single call can consume over a $100 credit pack. */
export const MAX_ENDPOINT_COST_CREDITS = 1_000_000;

/** Keeps daily free-tier counters bounded to a realistic launch-scale value. */
export const MAX_DAILY_FREE_TIER_CALLS = 1_000_000;

export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
