// @vitest-environment jsdom
import { getChunks } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpecDiff } from "./spec-diff";

let state: EditorState;
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    extensions,
  }: {
    value: string;
    extensions: Extension[];
  }) => {
    state = EditorState.create({ doc: value, extensions });
    return <div />;
  },
}));
afterEach(cleanup);
it("builds a bounded unified diff for large unrelated documents", () => {
  const original = Array.from(
    { length: 12_000 },
    (_, i) => `"old${i}": ${i},`,
  ).join("\n");
  const modified = Array.from(
    { length: 12_000 },
    (_, i) => `"new${i}": ${i + 1},`,
  ).join("\n");
  render(<SpecDiff original={original} modified={modified} />);
  const result = getChunks(state);
  expect(result?.chunks.length).toBeGreaterThan(0);
  expect(result?.chunks[0]?.fromA).toBe(0);
  expect(result?.chunks.at(-1)?.toB).toBeGreaterThanOrEqual(modified.length);
  expect(state.readOnly).toBe(true);
}, 15_000);
