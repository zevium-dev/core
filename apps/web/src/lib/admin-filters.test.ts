import { describe, expect, it } from "vitest";

import type { Id } from "#/lib/convex-data-model";
import {
  ADMIN_STATUS_OPTIONS,
  ADMIN_VISIBILITY_OPTIONS,
  buildOrgByClerkIdMap,
  buildOrgNameMap,
  orgDisplayName,
  orgDisplayNameByClerkId,
  parseProjectStatus,
  parseProjectVisibility,
} from "#/lib/admin-filters";

describe("parseProjectStatus", () => {
  it("accepts the two literal statuses", () => {
    expect(parseProjectStatus("draft")).toBe("draft");
    expect(parseProjectStatus("published")).toBe("published");
  });

  it("returns undefined for 'all' and garbage", () => {
    expect(parseProjectStatus("all")).toBeUndefined();
    expect(parseProjectStatus(undefined)).toBeUndefined();
    expect(parseProjectStatus(null)).toBeUndefined();
    expect(parseProjectStatus("archived")).toBeUndefined();
    expect(parseProjectStatus(123)).toBeUndefined();
  });
});

describe("parseProjectVisibility", () => {
  it("accepts the two literal visibilities", () => {
    expect(parseProjectVisibility("private")).toBe("private");
    expect(parseProjectVisibility("public")).toBe("public");
  });

  it("returns undefined for 'all' and garbage", () => {
    expect(parseProjectVisibility("all")).toBeUndefined();
    expect(parseProjectVisibility("")).toBeUndefined();
    expect(parseProjectVisibility({})).toBeUndefined();
  });
});

describe("buildOrgNameMap + orgDisplayName", () => {
  const orgA = {
    _id: "org1" as Id<"organizations">,
    name: "Acme",
    slug: "acme",
  };
  const orgB = {
    _id: "org2" as Id<"organizations">,
    name: "",
    slug: "blank-co",
  };

  it("builds a map keyed by org id", () => {
    const map = buildOrgNameMap([orgA, orgB]);
    expect(map.get("org1" as Id<"organizations">)).toEqual({
      name: "Acme",
      slug: "acme",
    });
    expect(map.size).toBe(2);
  });

  it("prefers name, falls back to slug when name is empty", () => {
    const map = buildOrgNameMap([orgA, orgB]);
    expect(orgDisplayName("org1" as Id<"organizations">, map)).toBe("Acme");
    expect(orgDisplayName("org2" as Id<"organizations">, map)).toBe("blank-co");
  });

  it("returns — for an unknown org id", () => {
    const map = buildOrgNameMap([orgA]);
    expect(orgDisplayName("org-missing" as Id<"organizations">, map)).toBe("—");
  });

  it("is empty for an empty list", () => {
    expect(buildOrgNameMap([]).size).toBe(0);
  });

  it("later entries overwrite earlier ones (idempotent rebuild)", () => {
    const first = { _id: "o" as Id<"organizations">, name: "Old", slug: "old" };
    const second = {
      _id: "o" as Id<"organizations">,
      name: "New",
      slug: "new",
    };
    const map = buildOrgNameMap([first, second]);
    expect(orgDisplayName("o" as Id<"organizations">, map)).toBe("New");
  });
});

describe("buildOrgByClerkIdMap + orgDisplayNameByClerkId", () => {
  const orgA = { clerkOrgId: "org_a", name: "Acme", slug: "acme" };
  const orgB = { clerkOrgId: "org_b", name: "", slug: "blank-co" };

  it("builds a map keyed by clerkOrgId", () => {
    const map = buildOrgByClerkIdMap([orgA, orgB]);
    expect(map.get("org_a")).toEqual({ name: "Acme", slug: "acme" });
    expect(map.size).toBe(2);
  });

  it("prefers name, falls back to slug when name is empty", () => {
    const map = buildOrgByClerkIdMap([orgA, orgB]);
    expect(orgDisplayNameByClerkId("org_a", map)).toBe("Acme");
    expect(orgDisplayNameByClerkId("org_b", map)).toBe("blank-co");
  });

  it("returns — for an unknown clerkOrgId", () => {
    const map = buildOrgByClerkIdMap([orgA]);
    expect(orgDisplayNameByClerkId("org_missing", map)).toBe("—");
  });

  it("is empty for an empty list", () => {
    expect(buildOrgByClerkIdMap([]).size).toBe(0);
  });

  it("later entries overwrite earlier ones (idempotent rebuild)", () => {
    const first = { clerkOrgId: "org_x", name: "Old", slug: "old" };
    const second = { clerkOrgId: "org_x", name: "New", slug: "new" };
    const map = buildOrgByClerkIdMap([first, second]);
    expect(orgDisplayNameByClerkId("org_x", map)).toBe("New");
  });
});

describe("option lists are stable + exhaustive", () => {
  it("status options cover both statuses", () => {
    const values = ADMIN_STATUS_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual(["draft", "published"]);
  });

  it("visibility options cover both visibilities", () => {
    const values = ADMIN_VISIBILITY_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual(["private", "public"]);
  });
});
