import { describe, expect, it } from "vitest";

import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  it("keeps local paths with query state", () => {
    expect(
      safeReturnPath("/catalogue/acme/weather?tab=try&mode=live", "/app"),
    ).toBe("/catalogue/acme/weather?tab=try&mode=live");
  });

  it("rejects external, protocol-relative, and control-character paths", () => {
    expect(safeReturnPath("https://evil.test", "/app")).toBe("/app");
    expect(safeReturnPath("//evil.test", "/app")).toBe("/app");
    expect(safeReturnPath("/\\evil.test/path", "/app")).toBe("/app");
    expect(safeReturnPath("/%5Cevil.test/path", "/app")).toBe("/app");
    expect(safeReturnPath("/ok\nLocation: https://evil.test", "/app")).toBe(
      "/app",
    );
  });
});
