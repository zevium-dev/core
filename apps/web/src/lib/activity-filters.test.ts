import { describe, expect, it } from "vitest";

import {
  activitySinceMs,
  authorizedAttributionSearch,
  mergePublicUsagePages,
  mergeUsagePages,
  parseActivityTimeRange,
} from "./activity-filters";

describe("activitySinceMs", () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0); // 2026-07-11T12:00:00Z

  it("returns 24h window lower bound", () => {
    expect(activitySinceMs("24h", now)).toBe(now - 24 * 60 * 60 * 1000);
  });

  it("returns 7d and 30d lower bounds", () => {
    expect(activitySinceMs("7d", now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(activitySinceMs("30d", now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
  });

  it("returns undefined for all", () => {
    expect(activitySinceMs("all", now)).toBeUndefined();
  });
});

describe("parseActivityTimeRange", () => {
  it("accepts known ranges", () => {
    expect(parseActivityTimeRange("24h")).toBe("24h");
    expect(parseActivityTimeRange("7d")).toBe("7d");
    expect(parseActivityTimeRange("30d")).toBe("30d");
    expect(parseActivityTimeRange("all")).toBe("all");
  });

  it("defaults unknown to all", () => {
    expect(parseActivityTimeRange(undefined)).toBe("all");
    expect(parseActivityTimeRange("week")).toBe("all");
    expect(parseActivityTimeRange(7)).toBe("all");
  });
});

describe("mergeUsagePages", () => {
  const a = { _id: "a", n: 1 };
  const b = { _id: "b", n: 2 };
  const c = { _id: "c", n: 3 };

  it("replaces on first page", () => {
    expect(mergeUsagePages([a], [b, c], true)).toEqual([b, c]);
  });

  it("appends and dedupes by _id", () => {
    expect(mergeUsagePages([a, b], [b, c], false)).toEqual([a, b, c]);
  });

  it("keeps existing when incoming empty", () => {
    expect(mergeUsagePages([a], [], false)).toEqual([a]);
  });
});

describe("member activity authorization", () => {
  it("strips hostile colleague filters but preserves own-safe drill-downs", () => {
    expect(
      authorizedAttributionSearch(
        {
          member: "user_colleague",
          key: "key_owned",
          endpoint: "/v1/data",
          method: "GET",
        },
        false,
      ),
    ).toEqual({ key: "key_owned", endpoint: "/v1/data", method: "GET" });
    expect(
      authorizedAttributionSearch({ member: "user_colleague" }, true),
    ).toEqual({ member: "user_colleague" });
  });

  it("dedupes public usage rows without Convex ids", () => {
    const row = {
      eventId: "usage_public",
      at: 1,
      keyId: "key_owned",
      endpoint: "/v1/data",
      method: "GET",
    };
    const next = { ...row, eventId: "usage_next", at: 2 };
    expect(mergePublicUsagePages([row], [row, next], false)).toEqual([
      row,
      next,
    ]);
  });
});
