import { describe, expect, it } from "vitest";
import { extractPricing, parseSpec, matchOperation } from "./openapi";
import { parseTokenPricing, tokenCredits } from "./pricing";
import { collectOpenApiSpecIssues } from "./validate";

const rates = {
  per: "token" as const,
  input: 2000,
  output: 8000,
  maxPerCall: 1000,
};
describe("token pricing", () => {
  it("parses immutable spec rates and charges weighted usage", () => {
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
