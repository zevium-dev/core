import { describe, expect, it } from "vitest";

import {
  formatCataloguePriceRange,
  formatEndpointCount,
} from "./catalogue-card";

describe("formatCataloguePriceRange", () => {
  it("returns null for missing or empty pricing", () => {
    expect(formatCataloguePriceRange(null)).toBeNull();
    expect(formatCataloguePriceRange(undefined)).toBeNull();
    expect(
      formatCataloguePriceRange({
        minCost: 0,
        maxCost: 0,
        endpointCount: 0,
        hasFreeTier: false,
      }),
    ).toBeNull();
  });

  it("formats single cost", () => {
    expect(
      formatCataloguePriceRange({
        minCost: 3,
        maxCost: 3,
        endpointCount: 2,
        hasFreeTier: false,
      }),
    ).toBe("3 cr/call");
  });

  it("formats range", () => {
    expect(
      formatCataloguePriceRange({
        minCost: 1,
        maxCost: 8,
        endpointCount: 4,
        hasFreeTier: true,
      }),
    ).toBe("1–8 cr/call");
  });
});

describe("formatEndpointCount", () => {
  it("singular and plural", () => {
    expect(formatEndpointCount(0)).toBe("0 endpoints");
    expect(formatEndpointCount(1)).toBe("1 endpoint");
    expect(formatEndpointCount(12)).toBe("12 endpoints");
  });
});
