import { describe, expect, it } from "vitest";

import { safeAppReturnPath } from "./auth-redirect";

describe("safeAppReturnPath", () => {
  it("preserves local app callbacks and their checkout session", () => {
    expect(
      safeAppReturnPath("/app/billing?checkout=cs_test_123#confirmation"),
    ).toBe("/app/billing?checkout=cs_test_123#confirmation");
  });

  it.each([
    undefined,
    "",
    "https://evil.example/app",
    "//evil.example/app",
    "/application",
    "/catalogue",
    "/app\\evil.example",
    "/app\u0000/billing",
  ])("fails closed for unsafe target %j", (target) => {
    expect(safeAppReturnPath(target)).toBe("/app");
  });
});
