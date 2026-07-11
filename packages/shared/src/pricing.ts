export interface EndpointPricing {
  /** Credits per call — `x-zevium-cost`, default 1 */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
