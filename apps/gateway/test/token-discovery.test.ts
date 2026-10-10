import { describe, expect, it } from "vitest";
import { parseSpec } from "@zevium/shared";
import { endpointsFromSpec } from "../src/discovery";
import { apiDocsFromSpec } from "../src/mcp-api-docs";

const tokenPricing = {
  per: "token",
  input: 2000,
  output: 8000,
  maxPerCall: 1000,
};
const spec = parseSpec(
  JSON.stringify({
    paths: {
      "/chat": { post: { "x-zevium-cost": tokenPricing } },
      "/hidden": { post: { summary: "Hidden" } },
      "/free": { get: { "x-zevium-cost": 0 } },
    },
  }),
);
describe("token discovery", () => {
  it("exposes explicit token rates and hold ceiling, never a fake per-call price", () => {
    expect(endpointsFromSpec(spec)).toEqual([
      { method: "POST", path: "/chat", maxHoldCredits: 1000, tokenPricing },
      { method: "GET", path: "/free", credits: 0 },
    ]);
    const docs = JSON.stringify(apiDocsFromSpec(spec));
    expect(docs).toContain('"tokenPricing"');
    expect(docs).toContain('"input":2000');
    expect(docs).not.toContain("/hidden");
  });
});
