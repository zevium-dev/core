import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { apiKeyError } from "./api-key-error";

describe("key error allowlist", () => {
  it("shows only intentional allowlisted Convex errors", () => {
    expect(
      apiKeyError(new ConvexError("Verified key not found"), "Retry"),
    ).toBe("Verified key not found");
    for (const error of [
      new Error("Clerk request failed with internal details"),
      "raw provider error",
      new ConvexError("Unknown internal error"),
      new Error("Verified key not found"),
      { data: "Verified key not found" },
    ]) {
      expect(apiKeyError(error, "Retry")).toBe("Retry");
    }
  });
});
