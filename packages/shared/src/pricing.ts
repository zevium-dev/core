/** Control-plane and settlement boundary cap for one OpenAPI operation. */
export const MAX_ENDPOINT_COST_CREDITS = 1_000_000;

export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
