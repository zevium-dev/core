import { jsonLanguage } from "@codemirror/lang-json";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";

describe("JSON parser and highlighter compatibility", () => {
  it("highlights an OpenAPI draft without crashing the editor plugin", () => {
    const source = JSON.stringify({
      openapi: "3.1.0",
      paths: { "/health": { get: { "x-zevium-cost": 0 } } },
    });
    const tokens: { text: string; style: string }[] = [];
    highlightTree(
      jsonLanguage.parser.parse(source),
      classHighlighter,
      (from, to, style) => {
        tokens.push({ text: source.slice(from, to), style });
      },
    );

    expect(tokens).toContainEqual({
      text: '"openapi"',
      style: "tok-propertyName",
    });
    expect(tokens).toContainEqual({ text: '"3.1.0"', style: "tok-string" });
    expect(tokens).toContainEqual({ text: "0", style: "tok-number" });
  });

  it("continues highlighting while the user types an incomplete draft", () => {
    expect(() =>
      highlightTree(
        jsonLanguage.parser.parse('{"paths": {'),
        classHighlighter,
        () => {},
      ),
    ).not.toThrow();
  });
});
