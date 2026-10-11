import { afterEach, describe, expect, it, vi } from "vitest";
import * as pricingPolicy from "./pricing-policy";
import { extractPricing, parseSpec, matchOperation } from "./openapi";
import { parseTokenPricing, tokenCredits } from "./pricing";
import { collectOpenApiSpecIssues } from "./validate";

afterEach(() => vi.restoreAllMocks());

const rates = {
  per: "token" as const,
  input: 2000,
  output: 8000,
  maxPerCall: 1000,
};
describe("token pricing", () => {
  it("defaults off, preserves fixed prices, and never falls through to a priced template", () => {
    expect(pricingPolicy.isTokenPricingEnabled()).toBe(false);
    expect(extractPricing({ "x-zevium-cost": rates })).toBeNull();
    expect(
      extractPricing({ "x-zevium-cost": { ...rates, input: 0, output: 0 } }),
    ).toBeNull();
    expect(extractPricing({ "x-zevium-cost": 0 })).toEqual({ cost: 0 });
    expect(extractPricing({ "x-zevium-cost": 7 })).toEqual({ cost: 7 });
    const spec = parseSpec(
      JSON.stringify({
        paths: {
          "/chat": { post: { "x-zevium-cost": rates } },
          "/{id}": { post: { "x-zevium-cost": 7 } },
        },
      }),
    );
    expect(matchOperation(spec, "POST", "/chat")).toBeNull();
    expect(matchOperation(spec, "POST", "/other")?.pricing.cost).toBe(7);
  });

  it.each([false, true])(
    "allows publication with an unavailable warning only when disabled: %s",
    (enabled) => {
      if (enabled)
        vi.spyOn(pricingPolicy, "isTokenPricingEnabled").mockReturnValue(true);
      const issues = collectOpenApiSpecIssues(
        JSON.stringify({
          openapi: "3.1.0",
          servers: [{ url: "https://example.com" }],
          paths: { "/chat": { post: { "x-zevium-cost": rates } } },
        }),
      );
      expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
      expect(
        issues.some(
          (issue) =>
            issue.level === "warning" &&
            issue.message.includes("Per-token pricing is currently disabled"),
        ),
      ).toBe(!enabled);
    },
  );

  it("parses immutable spec rates and charges weighted usage when enabled", () => {
    vi.spyOn(pricingPolicy, "isTokenPricingEnabled").mockReturnValue(true);
    expect(extractPricing({ "x-zevium-cost": rates })).toEqual({
      cost: 1000,
      token: rates,
    });
    expect(tokenCredits(rates, 1000, 2000)).toBe(18);
    expect(tokenCredits(rates, 1, 1, true)).toBe(1);
    expect(tokenCredits(rates, 1, 1)).toBe(0);
    expect(
      tokenCredits(rates, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ).toBe(1000);
    const spec = parseSpec(
      JSON.stringify({
        paths: { "/chat": { post: { "x-zevium-cost": rates } } },
      }),
    );
    expect(matchOperation(spec, "POST", "/chat")?.pricing.token).toEqual(rates);
  });
  it.each([
    { ...rates, input: -1 },
    { ...rates, output: 1.5 },
    { ...rates, maxPerCall: 0 },
    { ...rates, output: Infinity },
    { ...rates, input: 1_000_001 },
    { ...rates, per: "tokens" },
    { ...rates, extra: 1 },
    { per: "token", input: 2 },
  ])("rejects invalid rates in parser and editor lint: %j", (invalid) => {
    expect(() => parseTokenPricing(invalid)).toThrow(/Token|token pricing/);
    const issues = collectOpenApiSpecIssues(
      JSON.stringify({
        openapi: "3.1.0",
        servers: [{ url: "https://example.com" }],
        paths: { "/chat": { post: { "x-zevium-cost": invalid } } },
      }),
    );
    expect(
      issues.some(
        (issue) =>
          issue.level === "error" && issue.path.endsWith("x-zevium-cost"),
      ),
    ).toBe(true);
  });
});
