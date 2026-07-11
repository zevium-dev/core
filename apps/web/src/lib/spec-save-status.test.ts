import { describe, expect, it } from "vitest";
import { deriveSaveStatus, formatSavedAgo } from "./spec-save-status";

describe("formatSavedAgo", () => {
  it("formats seconds and minutes", () => {
    expect(formatSavedAgo(1000, 1000)).toBe("saved just now");
    expect(formatSavedAgo(1000, 1000 + 12_000)).toBe("saved 12s ago");
    expect(formatSavedAgo(1000, 1000 + 120_000)).toBe("saved 2m ago");
  });
});

describe("deriveSaveStatus", () => {
  it("prioritizes saving and errors", () => {
    expect(
      deriveSaveStatus({
        dirty: true,
        saving: true,
        hasClientErrors: true,
        lastSavedAt: 1,
        now: 2,
      }).kind,
    ).toBe("saving");

    expect(
      deriveSaveStatus({
        dirty: true,
        saving: false,
        hasClientErrors: true,
        lastSavedAt: 1,
        now: 2,
      }),
    ).toEqual({ kind: "fix-errors", label: "fix errors to save" });
  });

  it("shows unsaved and saved", () => {
    expect(
      deriveSaveStatus({
        dirty: true,
        saving: false,
        hasClientErrors: false,
        lastSavedAt: 1,
        now: 2,
      }).kind,
    ).toBe("unsaved");

    const saved = deriveSaveStatus({
      dirty: false,
      saving: false,
      hasClientErrors: false,
      lastSavedAt: 1000,
      now: 1000 + 8000,
    });
    expect(saved.kind).toBe("saved");
    expect(saved.label).toBe("saved 8s ago");
  });
});
