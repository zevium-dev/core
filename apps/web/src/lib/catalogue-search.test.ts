import { describe, expect, it } from "vitest";

import {
  catalogueLoaderDeps,
  catalogueUrlSearch,
  formatRelevance,
  parseCatalogueMaxCost,
  relevanceFraction,
  validateCatalogueSearch,
} from "./catalogue-search";

describe("catalogue route state", () => {
  it("keeps semantic state out of exact loader dependencies", () => {
    const browse = validateCatalogueSearch({
      q: "weather",
      tag: "forecast",
      sort: "cheapest",
      free: "1",
      semantic: "1",
      max: "4",
    });

    expect(catalogueLoaderDeps(browse)).toEqual({
      q: "weather",
      tag: "forecast",
      sort: "cheapest",
      free: true,
      max: 4,
    });
    expect(catalogueLoaderDeps({ ...browse, semantic: undefined })).toEqual(
      catalogueLoaderDeps(browse),
    );
  });

  it("rejects malformed and unsafe maximum-cost values", () => {
    expect(parseCatalogueMaxCost("0")).toBe(0);
    expect(parseCatalogueMaxCost("001")).toBe(1);
    expect(parseCatalogueMaxCost("-1")).toBeUndefined();
    expect(parseCatalogueMaxCost("1.5")).toBeUndefined();
    expect(parseCatalogueMaxCost("9007199254740992")).toBeUndefined();
  });

  it("canonicalizes drafts without retaining false default parameters", () => {
    expect(
      catalogueUrlSearch({
        q: "  ",
        tag: null,
        sort: "newest",
        freeOnly: false,
        maxCostInput: "not-a-number",
        semantic: false,
      }),
    ).toEqual({
      q: undefined,
      tag: undefined,
      sort: undefined,
      free: undefined,
      max: undefined,
      semantic: undefined,
    });
  });
});

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
