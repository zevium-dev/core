import { describe, expect, it } from "vitest";

import { CAP_ERROR, formatMonthlyCap, parseMonthlyCap } from "./key-cap";

describe("parseMonthlyCap", () => {
  it("blank input is unlimited (null)", () => {
    expect(parseMonthlyCap("")).toEqual({ ok: true, cap: null });
    expect(parseMonthlyCap("   ")).toEqual({ ok: true, cap: null });
  });

  it("positive whole number is the cap", () => {
    expect(parseMonthlyCap("100")).toEqual({ ok: true, cap: 100 });
    expect(parseMonthlyCap(" 5000 ")).toEqual({ ok: true, cap: 5000 });
    expect(parseMonthlyCap("1")).toEqual({ ok: true, cap: 1 });
  });

  it("rejects zero and negatives", () => {
    expect(parseMonthlyCap("0")).toEqual({ ok: false, error: CAP_ERROR });
    expect(parseMonthlyCap("-5")).toEqual({ ok: false, error: CAP_ERROR });
  });

  it("rejects fractions", () => {
    expect(parseMonthlyCap("1.5")).toEqual({ ok: false, error: CAP_ERROR });
    expect(parseMonthlyCap("0.99")).toEqual({ ok: false, error: CAP_ERROR });
  });

  it("rejects non-numbers", () => {
    expect(parseMonthlyCap("abc")).toEqual({ ok: false, error: CAP_ERROR });
    expect(parseMonthlyCap("1e3")).toEqual({ ok: true, cap: 1000 });
    expect(parseMonthlyCap("")).toEqual({ ok: true, cap: null });
  });
});

describe("formatMonthlyCap", () => {
  it("undefined is Unlimited", () => {
    expect(formatMonthlyCap(undefined)).toBe("Unlimited");
  });

  it("numbers are grouped", () => {
    expect(formatMonthlyCap(1000)).toBe("1,000");
    expect(formatMonthlyCap(100)).toBe("100");
    expect(formatMonthlyCap(1000000)).toBe("1,000,000");
  });
});
