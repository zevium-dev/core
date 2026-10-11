/** Pricing rollup returned by catalogue.listPublic. */
export type CatalogueCardPricing = {
  minCost: number;
  maxCost: number;
  endpointCount: number;
  hasFreeTier: boolean;
};

/** Price chip text for catalogue cards: "1 cr/call" or "1–8 cr/call". */
export function formatCataloguePriceRange(
  pricing: CatalogueCardPricing | null | undefined,
): string | null {
  if (pricing === null || pricing === undefined) return null;
  if (pricing.endpointCount === 0) return null;
  if (pricing.minCost === pricing.maxCost) {
    return `${pricing.minCost} cr/call`;
  }
  return `${pricing.minCost}–${pricing.maxCost} cr/call`;
}

/** Endpoint count chip: "3 endpoints" / "1 endpoint". */
export function formatEndpointCount(count: number): string {
  if (count === 1) return "1 endpoint";
  return `${count} endpoints`;
}
