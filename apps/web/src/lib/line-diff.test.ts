import { describe, expect, it } from "vitest";

import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("returns all context for identical text", () => {
    const out = lineDiff("a\nb\nc", "a\nb\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("marks pure additions", () => {
    const out = lineDiff("a\nc", "a\nb\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "added", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("marks pure removals", () => {
    const out = lineDiff("a\nb\nc", "a\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles a mixed edit", () => {
    const out = lineDiff("a\nold\nc", "a\nnew\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "context", text: "c" },
    ]);
  });

  it("treats empty old as all-added", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { type: "added", text: "x" },
      { type: "added", text: "y" },
    ]);
  });

  it("treats empty new as all-removed", () => {
    expect(lineDiff("x\ny", "")).toEqual([
      { type: "removed", text: "x" },
      { type: "removed", text: "y" },
    ]);
  });

  it("returns [] when both empty", () => {
    expect(lineDiff("", "")).toEqual([]);
  });

  it("keeps common subsequences aligned (no spurious churn)", () => {
    const old = '{\n  "a": 1,\n  "b": 2\n}';
    const next = '{\n  "a": 1,\n  "b": 3,\n  "c": 4\n}';
    const out = lineDiff(old, next);
    const ctx = out.filter((l) => l.type === "context").map((l) => l.text);
    // the unchanged lines stay context, not deleted+readded
    expect(ctx).toContain('  "a": 1,');
    expect(out).toContainEqual({ type: "removed", text: '  "b": 2' });
    expect(out).toContainEqual({ type: "added", text: '  "b": 3,' });
    expect(out).toContainEqual({ type: "added", text: '  "c": 4' });
  });
  it("surfaces a trailing-newline difference as a removed empty line", () => {
    // "a\n" -> ["a",""]; "a" -> ["a"]; the trailing newline is a real diff
    const out = lineDiff("a\n", "a");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "" },
    ]);
  });
});
