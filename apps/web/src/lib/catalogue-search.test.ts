import { describe, expect, it } from "vitest";

import { formatRelevance, relevanceFraction } from "./catalogue-search";

describe("relevanceFraction", () => {
  it("passes through values in [0,1]", () => {
    expect(relevanceFraction(0)).toBe(0);
    expect(relevanceFraction(0.5)).toBe(0.5);
    expect(relevanceFraction(1)).toBe(1);
  });

  it("clamps negative cosine scores to 0", () => {
    expect(relevanceFraction(-0.4)).toBe(0);
    expect(relevanceFraction(-1)).toBe(0);
  });

  it("clamps values above 1 to 1", () => {
    expect(relevanceFraction(1.5)).toBe(1);
  });

  it("treats NaN as 0", () => {
    expect(relevanceFraction(Number.NaN)).toBe(0);
  });
});

describe("formatRelevance", () => {
  it("formats a typical score as a percent match", () => {
    expect(formatRelevance(0.873)).toBe("87% match");
  });

  it("rounds to whole percent", () => {
    expect(formatRelevance(0.875)).toBe("88% match");
  });

  it("clamps the extremes", () => {
    expect(formatRelevance(1)).toBe("100% match");
    expect(formatRelevance(-0.2)).toBe("0% match");
    expect(formatRelevance(Number.NaN)).toBe("0% match");
  });
});
