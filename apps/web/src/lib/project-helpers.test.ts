import { describe, expect, it } from "vitest";

import {
  CREDITS_PER_DOLLAR,
  PUBLISHER_SHARE,
  creditsToDollars,
  formatCreditsAsUsd,
  parseTagsInput,
} from "./project-helpers";

describe("credits conversion", () => {
  it("maps 10_000 credits to $1", () => {
    expect(CREDITS_PER_DOLLAR).toBe(10_000);
    expect(creditsToDollars(10_000)).toBe(1);
    expect(formatCreditsAsUsd(10_000)).toBe("$1.00");
  });

  it("handles zero and fractions", () => {
    expect(creditsToDollars(0)).toBe(0);
    expect(formatCreditsAsUsd(0)).toBe("$0.00");
    expect(creditsToDollars(2_500)).toBe(0.25);
    expect(formatCreditsAsUsd(2_500)).toBe("$0.25");
  });

  it("shows sub-cent amounts without rounding to zero", () => {
    // 5 credits = $0.0005
    expect(formatCreditsAsUsd(5)).toBe("$0.0005");
  });

  it("guards non-finite inputs", () => {
    expect(creditsToDollars(Number.NaN)).toBe(0);
    expect(formatCreditsAsUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });

  it("documents publisher share constant", () => {
    expect(PUBLISHER_SHARE).toBe(0.95);
    expect(Math.round(1000 * PUBLISHER_SHARE)).toBe(950);
  });
});

describe("parseTagsInput", () => {
  it("splits on commas, trims, lowercases, dedupes", () => {
    expect(parseTagsInput(" AI,  llm ,AI, Tools ")).toEqual([
      "ai",
      "llm",
      "tools",
    ]);
  });

  it("accepts newline-separated tags", () => {
    expect(parseTagsInput("foo\nbar\nfoo")).toEqual(["foo", "bar"]);
  });

  it("returns empty for blank input", () => {
    expect(parseTagsInput("")).toEqual([]);
    expect(parseTagsInput("  ,  , ")).toEqual([]);
  });
});
