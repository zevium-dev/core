import { describe, expect, it } from "vitest";

import {
  activitySinceMs,
  authorizedAttributionSearch,
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
});
