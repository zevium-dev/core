import { describe, expect, it } from "vitest";
import { canAdministerOrg } from "./org-permissions";

describe("canAdministerOrg", () => {
  it("allows only the exact Clerk org-admin role", () => {
    expect(canAdministerOrg("org:admin")).toBe(true);
  });

  it.each([
    "org:member",
    "admin",
    "ORG:ADMIN",
    "",
    undefined,
    null,
    false,
    { role: "org:admin" },
  ])("fails closed for %j", (role) => {
    expect(canAdministerOrg(role)).toBe(false);
  });
});
