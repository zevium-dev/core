import { describe, expect, it } from "vitest";
import {
  formatCredits,
  formatNumber,
  formatMoney,
  formatDate,
  formatDateTime,
  formatTimestamp,
} from "./format";

describe("shared display formats", () => {
  it("keeps minor money units and fractional publisher credits distinct", () => {
    expect(formatMoney(1099, "usd")).toBe("$10.99");
    expect(formatCredits(1234.99)).toBe("1,234");
    expect(formatNumber(1234.95)).toBe("1,234.95");
    expect(formatCredits(Number.NaN)).toBe("0");
  });
  it("uses the UTC day at a local-midnight boundary", () => {
    const at = Date.parse("2026-10-10T23:59:05Z");
    expect(formatDate(at)).toBe("Oct 10, 2026");
    expect(formatDateTime(at)).toBe("Oct 10, 2026, 11:59 PM UTC");
    expect(formatTimestamp(at)).toBe("Oct 10, 2026, 11:59:05 PM UTC");
  });
});
