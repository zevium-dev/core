import { afterEach, describe, expect, it, vi } from "vitest";
import * as pricingPolicy from "../../../../packages/shared/src/pricing-policy";
import { listSpecEndpoints } from "./spec-endpoints";
import { parsePublishedEndpoints } from "./openapi-reference";
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
  it("hides disabled token operations from the reference and price summary and scalar editor controls", () => {
    expect(parsePublishedEndpoints(spec)).toEqual([]);
    expect(listSpecEndpoints(spec)).toMatchObject([
      { path: "/hidden", cost: null },
    ]);
    expect(summarizeEndpoints(listSpecEndpoints(spec)!)).toEqual({
      endpointCount: 1,
      minCredits: null,
      maxCredits: null,
      freeTier: 0,
    });
  });
  it("keeps token editor controls absent even under a test-only pricing override", () => {
    vi.spyOn(pricingPolicy, "isTokenPricingEnabled").mockReturnValue(true);
    expect(listSpecEndpoints(spec)).toMatchObject([
      { path: "/hidden", cost: null },
    ]);
    expect(parsePublishedEndpoints(spec)).toMatchObject([
      { path: "/chat", tokenPricing },
    ]);
    expect(
      formatPricingSummary(summarizeEndpoints(listSpecEndpoints(spec)!)),
    ).toBe("1 endpoints");
  });
});
