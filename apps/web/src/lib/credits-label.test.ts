import { describe, expect, it } from "vitest";

import { creditsLabel } from "./credits-label";

describe("creditsLabel", () => {
  it("singularizes exactly 1", () => {
    expect(creditsLabel(1)).toBe("1 credit");
  });

  it("pluralizes 0 and >1", () => {
    expect(creditsLabel(0)).toBe("0 credits");
    expect(creditsLabel(2)).toBe("2 credits");
    expect(creditsLabel(1000)).toBe("1000 credits");
  });

  it("pluralizes fractional and negative counts", () => {
    expect(creditsLabel(1.5)).toBe("1.5 credits");
    expect(creditsLabel(-1)).toBe("-1 credits");
  });
});
