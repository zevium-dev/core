import { describe, expect, it } from "vitest";
import { listSpecEndpoints } from "./spec-endpoints";
import { parsePublishedEndpoints } from "./openapi-reference";
import { formatCataloguePriceRange } from "./catalogue-card";
import { summarizeEndpoints, formatPricingSummary } from "./spec-pricing";

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
  it("preserves token rates in editor and public reference", () => {
    expect(listSpecEndpoints(spec)).toMatchObject([
      { path: "/chat", tokenPricing },
    ]);
    expect(parsePublishedEndpoints(spec)).toMatchObject([
      { path: "/chat", tokenPricing },
    ]);
    expect(
      formatPricingSummary(summarizeEndpoints(listSpecEndpoints(spec)!)),
    ).toBe("1 endpoint, 1 priced per token");
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
