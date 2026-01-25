import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDate } from "./time";

describe("formatDate", () => {
  const mockDate = new Date("2026-01-23T10:30:00Z");
  const mockNow = new Date("2026-01-23T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("default formatting", () => {
    it("formats date with default format", () => {
      const result = formatDate(mockDate);
      expect(result).toContain("Jan");
      expect(result).toContain("2026");
      // The formatted time depends on the local timezone, so we check for the hour format pattern
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it("accepts Date, number, or string input", () => {
      expect(formatDate(mockDate)).toBeDefined();
      expect(formatDate(mockDate.getTime())).toBeDefined();
      expect(formatDate(mockDate.toISOString())).toBeDefined();
    });
  });

  describe("dateOnly option", () => {
    it("formats date without time", () => {
      const result = formatDate(mockDate, { dateOnly: true });
      expect(result).toBe("January 23, 2026");
    });
  });

  describe("monthOnly option", () => {
    it("formats month and day only", () => {
      const result = formatDate(mockDate, { monthOnly: true });
      expect(result).toBe("Jan 23");
    });
  });

  describe("relative option", () => {
    it("shows 'just now' for seconds in the past", () => {
      const past = new Date(mockNow.getTime() - 30 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("just now");
    });

    it("shows 'Xm ago' for minutes in the past", () => {
      const past = new Date(mockNow.getTime() - 5 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("5m ago");
    });

    it("shows 'Xh ago' for hours in the past", () => {
      const past = new Date(mockNow.getTime() - 3 * 60 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("3h ago");
    });

    it("shows 'Xd ago' for days in the past", () => {
      const past = new Date(mockNow.getTime() - 5 * 24 * 60 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("5d ago");
    });

    it("shows 'Xmo ago' for months in the past", () => {
      const past = new Date(mockNow.getTime() - 40 * 24 * 60 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("1mo ago");
    });

    it("shows 'in a few seconds' for seconds in the future", () => {
      const future = new Date(mockNow.getTime() + 30 * 1000);
      const result = formatDate(future, { relative: true });
      expect(result).toBe("in a few seconds");
    });

    it("shows 'in Xm' for minutes in the future", () => {
      const future = new Date(mockNow.getTime() + 5 * 60 * 1000);
      const result = formatDate(future, { relative: true });
      expect(result).toBe("in 5m");
    });

    it("shows 'in Xh' for hours in the future", () => {
      const future = new Date(mockNow.getTime() + 3 * 60 * 60 * 1000);
      const result = formatDate(future, { relative: true });
      expect(result).toBe("in 3h");
    });

    it("shows 'in Xd' for days in the future", () => {
      const future = new Date(mockNow.getTime() + 5 * 24 * 60 * 60 * 1000);
      const result = formatDate(future, { relative: true });
      expect(result).toBe("in 5d");
    });

    it("shows 'in Xmo' for months in the future", () => {
      const future = new Date(mockNow.getTime() + 40 * 24 * 60 * 60 * 1000);
      const result = formatDate(future, { relative: true });
      expect(result).toBe("in 1mo");
    });
  });

  describe("forceAgo option", () => {
    it("forces 'ago' format for future dates", () => {
      const future = new Date(mockNow.getTime() + 5 * 24 * 60 * 60 * 1000);
      const result = formatDate(future, { forceAgo: true, relative: true });
      expect(result).toBe("5d ago");
    });

    it("keeps 'ago' format for past dates", () => {
      const past = new Date(mockNow.getTime() - 5 * 24 * 60 * 60 * 1000);
      const result = formatDate(past, { forceAgo: true, relative: true });
      expect(result).toBe("5d ago");
    });
  });

  describe("format option", () => {
    it("uses custom format when provided", () => {
      const result = formatDate(mockDate, { format: "dateOnly" });
      expect(result).toContain("Jan");
      expect(result).toContain("23");
    });
  });

  describe("smart option", () => {
    it("uses relative time for recent dates (e.g., 2 days ago)", () => {
      const recent = new Date(mockNow.getTime() - 2 * 24 * 60 * 60 * 1000);
      const result = formatDate(recent, { smart: true });
      expect(result).toBe("2d ago");
    });

    it("uses absolute time for old dates (e.g., 10 days ago)", () => {
      const old = new Date(mockNow.getTime() - 10 * 24 * 60 * 60 * 1000);
      const result = formatDate(old, { smart: true });
      expect(result).toContain("Jan");
      expect(result).toContain("2026");
      expect(result).not.toContain(":"); // Should not include time
    });

    it("uses 'just now' for very recent dates", () => {
      const justNow = new Date(mockNow.getTime() - 10 * 1000);
      const result = formatDate(justNow, { smart: true });
      expect(result).toBe("just now");
    });
  });

  describe("edge cases", () => {
    it("handles exact 60 seconds ago", () => {
      const past = new Date(mockNow.getTime() - 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("1m ago");
    });

    it("handles exact 24 hours ago", () => {
      const past = new Date(mockNow.getTime() - 24 * 60 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("1d ago");
    });

    it("handles multiple months", () => {
      const past = new Date(mockNow.getTime() - 65 * 24 * 60 * 60 * 1000);
      const result = formatDate(past, { relative: true });
      expect(result).toBe("2mo ago");
    });

    it("returns nullish values gracefully", () => {
      const result = formatDate(mockNow, {});
      expect(result).toBeDefined();
      expect(result).toBeTruthy();
    });
  });
});
