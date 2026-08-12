import { describe, expect, it } from "vitest";

import {
  formatCountdown,
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
    expect(truncateKeyId(["sk", "live", "abcdefghijklmnop"].join("_"))).toBe(
      "sk_liv…mnop",
    );
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

describe("formatCountdown", () => {
  it("clamps non-positive and non-finite to 0s", () => {
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(-5)).toBe("0s");
    expect(formatCountdown(Number.NaN)).toBe("0s");
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe("0s");
  });

  it("rounds up fractional seconds under a minute", () => {
    expect(formatCountdown(1)).toBe("1s");
    expect(formatCountdown(4.2)).toBe("5s");
    expect(formatCountdown(58.4)).toBe("59s");
    // anything ceiling to a full minute rolls over to the minute format
    expect(formatCountdown(59.9)).toBe("1m");
  });

  it("compounds whole minutes with seconds", () => {
    expect(formatCountdown(60)).toBe("1m");
    expect(formatCountdown(90)).toBe("1m 30s");
    expect(formatCountdown(125)).toBe("2m 5s");
  });
});
