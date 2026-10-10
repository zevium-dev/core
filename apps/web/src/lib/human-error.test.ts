import { describe, expect, it } from "vitest";
import { humanError } from "./human-error";

describe("humanError allowlist", () => {
  it.each([
    new Error("sql: private table"),
    new Error("token=secret"),
    "private provider failure",
    new Error("toString"),
    {},
    null,
  ])("hides unknown errors, even short ones", (error) => {
    expect(humanError(error, "Could not save")).toBe("Could not save");
  });
  it("maps only known authorization and finance errors", () => {
    expect(humanError(new Error("Forbidden"))).toContain("organization role");
    expect(humanError(new Error("TRANSFER_REQUIRES_RECONCILIATION"))).toContain(
      "avoid sending funds twice",
    );
    expect(
      humanError(new Error("TRANSFER_REQUIRES_RECONCILIATION secret"), "Retry"),
    ).toBe("Retry");
  });
});
