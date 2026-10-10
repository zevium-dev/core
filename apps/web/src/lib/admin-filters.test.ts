import { describe, expect, it } from "vitest";

import {
  ADMIN_STATUS_OPTIONS,
  ADMIN_VISIBILITY_OPTIONS,
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
