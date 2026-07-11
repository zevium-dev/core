import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relative-time";

const NOW = new Date("2026-07-11T12:00:00Z").getTime();

describe("formatRelativeTime", () => {
  it("says 'just now' under 45s", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 44_000, NOW)).toBe("just now");
  });

  it("renders minutes", () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1m");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe("59m");
  });

  it("renders hours", () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe("1h");
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe("3h");
    expect(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe("23h");
  });

  it("renders days", () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe("1d");
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("2d");
    expect(formatRelativeTime(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe("6d");
  });

  it("renders weeks", () => {
    expect(formatRelativeTime(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe("1w");
    expect(formatRelativeTime(NOW - 4 * 7 * 24 * 60 * 60_000, NOW)).toBe("4w");
  });

  it("falls back to an absolute date beyond ~5 weeks", () => {
    // ~60 days back from 2026-07-11 → mid-May
    const out = formatRelativeTime(NOW - 60 * 24 * 60 * 60_000, NOW);
    expect(out).toMatch(/May/);
    expect(out).toMatch(/\d+/);
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe("just now");
  });

  it("rounds down, never up", () => {
    // 119s is still 1m, not 2m
    expect(formatRelativeTime(NOW - 119_000, NOW)).toBe("1m");
  });
});
