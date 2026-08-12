import { describe, expect, it } from "vitest";
import {
  convertSpecInputToJson,
  looksLikeYaml,
  MAX_YAML_ALIASES,
} from "./spec-yaml";

describe("looksLikeYaml", () => {
  it("detects yaml-ish paste", () => {
    expect(looksLikeYaml("openapi: 3.1.0\ninfo:\n  title: x")).toBe(true);
  });

  it("rejects json and empty", () => {
    expect(looksLikeYaml('{"openapi":"3.1.0"}')).toBe(false);
    expect(looksLikeYaml("")).toBe(false);
    expect(looksLikeYaml("  ")).toBe(false);
  });
});

describe("convertSpecInputToJson", () => {
  it("keeps valid JSON text", () => {
    const raw = '{\n  "openapi": "3.1.0"\n}';
    const result = convertSpecInputToJson(raw);
    expect(result).toEqual({
      ok: true,
      json: raw,
      convertedFromYaml: false,
    });
  });

  it("converts YAML to pretty JSON", () => {
    const yaml = `openapi: "3.1.0"
info:
  title: Demo
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths: {}
`;
    const result = convertSpecInputToJson(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.convertedFromYaml).toBe(true);
    const parsed = JSON.parse(result.json) as {
      openapi: string;
      info: { title: string };
    };
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.info.title).toBe("Demo");
  });

  it("errors on garbage", () => {
    const result = convertSpecInputToJson(":\n  - bad: [");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Could not parse/);
  });

  it("allows empty", () => {
    expect(convertSpecInputToJson("")).toEqual({
      ok: true,
      json: "",
      convertedFromYaml: false,
    });
  });

  it("rejects alias bombs before post-expansion serialization", () => {
    const aliases = Array.from(
      { length: MAX_YAML_ALIASES + 1 },
      (_, index) => `  item${index}: *seed`,
    ).join("\n");
    const result = convertSpecInputToJson(`seed: &seed
  value: ${"x".repeat(1_000)}
expanded:
${aliases}`);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/alias|complexity/i);
  });

  it("rejects exponential expansion even below alias-count ceiling", () => {
    const result = convertSpecInputToJson(`a: &a [x, x, x, x, x, x, x, x, x, x]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]`);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/alias|complexity|size/i);
  });

  it("rejects post-expansion output beyond transport cap", () => {
    const chunk = "x".repeat(220_000);
    const aliases = Array.from({ length: 10 }, () => "  - *seed").join("\n");
    const result = convertSpecInputToJson(`seed: &seed ${chunk}
expanded:
${aliases}`);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/size/i);
  });
});
