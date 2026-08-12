import { describe, expect, it } from "vitest";

import {
  ORG_CAPABILITIES,
  capabilityProjectionsMatch,
  hasServerCapability,
  parseOrgCapabilityProjection,
} from "./org-capabilities";

function projection(role: "org:admin" | "org:member", allowed: boolean) {
  return {
    role,
    capabilities: Object.fromEntries(
      ORG_CAPABILITIES.map((capability) => [capability, allowed]),
    ),
    reasons: Object.fromEntries(
      ORG_CAPABILITIES.map((capability) => [
        capability,
        allowed ? null : "Server denied this capability.",
      ]),
    ),
  };
}

describe("server organization capability projection", () => {
  it("never derives access from a privileged-looking role", () => {
    const parsed = parseOrgCapabilityProjection(projection("org:admin", false));
    expect(hasServerCapability(parsed, "manageBilling")).toBe(false);
    expect(hasServerCapability(null, "manageBilling")).toBe(false);
  });

  it("rejects incomplete or malformed projections", () => {
    expect(
      parseOrgCapabilityProjection({
        role: "org:member",
        capabilities: { manageBilling: false },
        reasons: { manageBilling: "Denied" },
      }),
    ).toBeNull();
    expect(
      parseOrgCapabilityProjection({
        ...projection("org:member", false),
        role: "org:super-admin",
      }),
    ).toBeNull();
  });

  it("accepts complete server projections", () => {
    const parsed = parseOrgCapabilityProjection(
      projection("org:member", false),
    );
    expect(parsed?.role).toBe("org:member");
    expect(parsed?.reasons.viewOrgUsage).toBe("Server denied this capability.");
  });

  it("rejects data produced under a different capability snapshot", () => {
    const owner = parseOrgCapabilityProjection(projection("org:admin", true));
    const stale = parseOrgCapabilityProjection({
      ...projection("org:admin", true),
      capabilities: {
        ...projection("org:admin", true).capabilities,
        viewOrgUsage: false,
      },
    });

    expect(capabilityProjectionsMatch(owner, owner)).toBe(true);
    expect(capabilityProjectionsMatch(owner, stale)).toBe(false);
    expect(capabilityProjectionsMatch(owner, null)).toBe(false);
  });
});
