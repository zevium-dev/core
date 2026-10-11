import { expect, it } from "vitest";
import { getParsedSpec, isPublishedSpecReadable } from "../src/spec-source";
it("caches immutable spec bytes while rejecting malformed versions", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Fixture", version: "1" },
    servers: [{ url: "https://example.com" }],
    paths: {},
  });
  expect(getParsedSpec({ spec })).toBe(getParsedSpec({ spec }));
  expect(isPublishedSpecReadable({ spec: "invalid" })).toBe(false);
});
