import { describe, expect, it } from "vitest";
import { summarizeEndpoints } from "./spec-pricing";
import { listSpecEndpoints } from "./spec-endpoints";

function summarizeDraftPricing(text: string) {
  return summarizeEndpoints(listSpecEndpoints(text) ?? []);
}

describe("draft pricing summary", () => {
  it.each([0, 5])(
    "uses only explicit prices for the range, including %i",
    (cost) => {
      expect(
        summarizeDraftPricing(
          JSON.stringify({
            paths: {
              "/hidden": { get: { "x-zevium-free-tier": 10 } },
              "/visible": { get: { "x-zevium-cost": cost } },
              "/paid": { post: { "x-zevium-cost": 8 } },
            },
          }),
        ),
      ).toEqual({
        endpointCount: 3,
        minCredits: cost,
        maxCredits: 8,
        freeTier: 0,
      });
    },
  );
  it("has no price range when all operations are unpriced", () => {
    expect(
      summarizeDraftPricing(
        JSON.stringify({ paths: { "/hidden": { get: {} } } }),
      ),
    ).toEqual({
      endpointCount: 1,
      minCredits: null,
      maxCredits: null,
      freeTier: 0,
    });
  });
});
