import { afterEach, describe, expect, it, vi } from "vitest";
import * as pricingPolicy from "../../../../packages/shared/src/pricing-policy";
import { listSpecEndpoints } from "./spec-endpoints";
import { parsePublishedEndpoints } from "./openapi-reference";
import { formatCataloguePriceRange } from "./catalogue-card";
import { summarizeEndpoints, formatPricingSummary } from "./spec-pricing";

afterEach(() => vi.restoreAllMocks());

const tokenPricing = {
  per: "token",
  input: 2000,
  output: 8000,
  maxPerCall: 1000,
};
const spec = JSON.stringify({
  paths: {
    "/chat": { post: { "x-zevium-cost": tokenPricing } },
    "/hidden": { get: {} },
  },
});
describe("token pricing surfaces", () => {
  it("hides disabled token operations from the reference and price summary while retaining editable rates", () => {
    expect(parsePublishedEndpoints(spec)).toEqual([]);
    expect(listSpecEndpoints(spec)).toMatchObject([
      { path: "/chat", cost: null, tokenPricing },
      { path: "/hidden", cost: null },
    ]);
    expect(summarizeEndpoints(listSpecEndpoints(spec)!)).toEqual({
      endpointCount: 2,
      minCredits: null,
      maxCredits: null,
      freeTier: 0,
    });
  });
  it("preserves token rates in editor and public reference when enabled", () => {
    vi.spyOn(pricingPolicy, "isTokenPricingEnabled").mockReturnValue(true);
    expect(listSpecEndpoints(spec)).toMatchObject([
      { path: "/chat", tokenPricing },
      { path: "/hidden", cost: null },
    ]);
    expect(parsePublishedEndpoints(spec)).toMatchObject([
      { path: "/chat", tokenPricing },
    ]);
    expect(
      formatPricingSummary(summarizeEndpoints(listSpecEndpoints(spec)!)),
    ).toBe("2 endpoints, 1 priced per token");
    expect(
      formatCataloguePriceRange({
        minCost: 1000,
        maxCost: 1000,
        endpointCount: 1,
        hasFreeTier: false,
        hasTokenPricing: true,
      }),
    ).toBe("Token pricing");
  });
});
