import { describe, expect, it } from "vitest";

import {
  resolveLocalJsonPointer,
  resolveLocalJsonRefChain,
} from "./json-pointer.js";

describe("resolveLocalJsonPointer", () => {
  const document = {
    components: {
      parameters: {
        "owner/id~key": { name: "id", in: "path" },
      },
      examples: [{ summary: "first" }, { summary: "second" }],
    },
  };

  it("implements URI fragment decoding and RFC 6901 escapes", () => {
    expect(
      resolveLocalJsonPointer(
        "#/components/parameters/owner~1id%7E0key",
        document,
      ),
    ).toEqual({ name: "id", in: "path" });
    expect(resolveLocalJsonPointer("#", document)).toBe(document);
    expect(
      resolveLocalJsonPointer("#/components/examples/1", document),
    ).toEqual({ summary: "second" });
  });

  it("fails closed on malformed, external, or excessive pointers", () => {
    expect(
      resolveLocalJsonPointer("#/components/parameters/owner~2id", document),
    ).toBeUndefined();
    expect(
      resolveLocalJsonPointer("https://example.com/spec.json#/x", document),
    ).toBeUndefined();
    expect(
      resolveLocalJsonPointer(`#/${"x/".repeat(65)}`, document),
    ).toBeUndefined();
    expect(
      resolveLocalJsonPointer("#/components/examples/01", document),
    ).toBeUndefined();
    expect(
      resolveLocalJsonPointer("#/components/examples/-", document),
    ).toBeUndefined();
    expect(
      resolveLocalJsonPointer("#/components/examples/2", document),
    ).toBeUndefined();
  });
});

describe("resolveLocalJsonRefChain", () => {
  it("resolves chains, applies siblings, and terminates cycles", () => {
    const document = {
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { type: "string", description: "base" },
          C: { $ref: "#/components/schemas/D" },
          D: { $ref: "#/components/schemas/C" },
        },
      },
    };

    expect(
      resolveLocalJsonRefChain(
        { $ref: "#/components/schemas/A", description: "sibling" },
        document,
      ),
    ).toEqual({ type: "string", description: "sibling" });
    expect(
      resolveLocalJsonRefChain({ $ref: "#/components/schemas/C" }, document),
    ).toEqual({});
  });
});
