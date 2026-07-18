import { describe, expect, it } from "vitest";

import {
  deliveryStatusView,
  truncateError,
  type WebhookDeliveryStatus,
} from "./webhook-delivery";

describe("deliveryStatusView", () => {
  it("maps ok to Delivered + success tokens", () => {
    const v = deliveryStatusView("ok");
    expect(v.label).toBe("Delivered");
    expect(v.badgeVariant).toBe("outline");
    expect(v.className).toContain("success");
    expect(v.dotClassName).toContain("success");
  });

  it("maps failed to Failed + destructive variant", () => {
    const v = deliveryStatusView("failed");
    expect(v.label).toBe("Failed");
    expect(v.badgeVariant).toBe("destructive");
  });

  it("maps pending to Pending + warning tokens", () => {
    const v = deliveryStatusView("pending");
    expect(v.label).toBe("Pending");
    expect(v.badgeVariant).toBe("outline");
    expect(v.className).toContain("warning");
  });

  it("covers every schema status exactly once", () => {
    const statuses: WebhookDeliveryStatus[] = ["ok", "failed", "pending"];
    const labels = new Set(statuses.map((s) => deliveryStatusView(s).label));
    expect(labels.size).toBe(statuses.length);
  });

  it("never leaks raw Tailwind colors", () => {
    const statuses: WebhookDeliveryStatus[] = ["ok", "failed", "pending"];
    for (const s of statuses) {
      const v = deliveryStatusView(s);
      expect(v.className).not.toMatch(/(red|green|yellow|amber|gray)-\d/);
    }
  });
});

describe("truncateError", () => {
  it("returns empty for undefined/empty", () => {
    expect(truncateError(undefined)).toBe("");
    expect(truncateError("")).toBe("");
    expect(truncateError("   ")).toBe("");
  });

  it("returns short errors unchanged", () => {
    expect(truncateError("boom", 80)).toBe("boom");
  });

  it("truncates long errors with an ellipsis at the limit", () => {
    const long = "x".repeat(120);
    const out = truncateError(long, 80);
    expect(out).toHaveLength(81); // 80 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("trims whitespace before measuring", () => {
    expect(truncateError("   short   ", 80)).toBe("short");
  });
});
