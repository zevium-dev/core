import { describe, expect, it } from "vitest";

import {
  buildDailyCallSeries,
  callBarScale,
  parseAnalyticsRange,
} from "./analytics-view";

describe("parseAnalyticsRange", () => {
  it("accepts only supported numeric and serialized URL values", () => {
    expect(parseAnalyticsRange(7)).toBe(7);
    expect(parseAnalyticsRange("30")).toBe(30);
    expect(parseAnalyticsRange(90)).toBe(90);
    expect(parseAnalyticsRange(14)).toBeNull();
    expect(parseAnalyticsRange("garbage")).toBeNull();
  });
});

describe("buildDailyCallSeries", () => {
  it("labels consecutive UTC days without local-time drift", () => {
    const start = Date.UTC(2026, 2, 7);
    expect(buildDailyCallSeries(start, [2, 0, 4])).toEqual([
      { at: start, label: "Mar 7, 2026", calls: 2 },
      { at: start + 86_400_000, label: "Mar 8, 2026", calls: 0 },
      { at: start + 2 * 86_400_000, label: "Mar 9, 2026", calls: 4 },
    ]);
  });
});

describe("callBarScale", () => {
  it("does not fabricate bars for zero calls", () => {
    expect(callBarScale(0, 10)).toBe(0);
    expect(callBarScale(1, 100)).toBe(0.06);
    expect(callBarScale(50, 100)).toBe(0.5);
    expect(callBarScale(200, 100)).toBe(1);
  });
});
