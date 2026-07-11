import { describe, expect, it } from "vitest";

import {
  formatCredits,
  formatCycleMonthLabel,
  isCycleEmpty,
  truncateKeyId,
} from "./billing-cycle";

describe("truncateKeyId", () => {
  it("short ids stay intact", () => {
    expect(truncateKeyId("abc")).toBe("abc");
    expect(truncateKeyId("abcdefghijk")).toBe("abcdefghijk");
  });

  it("long ids get head…tail", () => {
    expect(truncateKeyId("sk_live_abcdefghijklmnop")).toBe("sk_liv…mnop");
    expect(truncateKeyId("123456789012345", 4, 3)).toBe("1234…345");
  });

  it("empty becomes em dash", () => {
    expect(truncateKeyId("")).toBe("—");
    expect(truncateKeyId("   ")).toBe("—");
  });
});

describe("formatCredits", () => {
  it("formats integers with grouping", () => {
    expect(formatCredits(0)).toBe("0");
    expect(formatCredits(1000)).toBe("1,000");
    expect(formatCredits(12_345.9)).toBe("12,345");
  });

  it("non-finite becomes 0", () => {
    expect(formatCredits(Number.NaN)).toBe("0");
    expect(formatCredits(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatCycleMonthLabel", () => {
  it("labels UTC month from cycle start", () => {
    // 2026-07-01T00:00:00.000Z
    expect(formatCycleMonthLabel(Date.UTC(2026, 6, 1))).toBe("Jul 2026 (UTC)");
    expect(formatCycleMonthLabel(Date.UTC(2026, 0, 1))).toBe("Jan 2026 (UTC)");
  });
});

describe("isCycleEmpty", () => {
  it("true when no calls and no credits", () => {
    expect(
      isCycleEmpty({
        totalCalls: 0,
        totalCredits: 0,
        byProject: [],
        byKey: [],
      }),
    ).toBe(true);
  });

  it("false when any activity", () => {
    expect(
      isCycleEmpty({
        totalCalls: 1,
        totalCredits: 0,
        byProject: [],
        byKey: [],
      }),
    ).toBe(false);
    expect(
      isCycleEmpty({
        totalCalls: 0,
        totalCredits: 10,
        byProject: [],
        byKey: [],
      }),
    ).toBe(false);
  });
});
