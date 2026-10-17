import { describe, expect, it } from "vitest";
import { generateSpecContract, MAX_GENERATED_BYTES } from "./index.js";
import { generatedCallArguments, generatedToolArguments } from "./cli.js";
import { representativeSpec } from "./fixture.js";

const generate = (spec: unknown = representativeSpec, version = "2.0.0") =>
  generateSpecContract({ spec: JSON.stringify(spec), version });
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, v]) => [key, reversed(v)]),
    );
  return value;
}
const withBody = (schema: unknown, extra = {}) => ({
  openapi: "3.1.0",
  ...extra,
  paths: {
    "/test": {
      post: {
        "x-zevium-cost": 1,
        requestBody: { content: { "application/json": { schema } } },
      },
    },
  },
});

describe("published spec generation", () => {
  it("matches golden MCP, CLI and Markdown artifacts", async () => {
    await expect(
      JSON.stringify(generate(), null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/representative.golden.txt");
    expect(JSON.stringify(generate())).not.toMatch(
      /HIDDEN_SENTINEL|private-upstream/,
    );
    expect(generate().version).toBe("2.0.0");
    expect(generate().operations.map((o) => o.credits)).toEqual([3, 0, 0]);
  });
  it("is independent of object key order and repeated generation", () => {
    expect(generate(reversed(representativeSpec))).toEqual(generate());
    expect(generate()).toEqual(generate());
  });
  it("preserves string and null JSON bodies through call_api_write raw-body semantics", () => {
    const operation = generate(withBody({ type: ["string", "null"] }))
      .operations[0]!;
    expect(
      generatedToolArguments(operation, "acme", "api", { body: "hello" }).body,
    ).toBe('"hello"');
    expect(
      generatedToolArguments(operation, "acme", "api", { body: null }).body,
    ).toBe("null");
    expect(
      generatedToolArguments(operation, "acme", "api", {}).body,
    ).toBeUndefined();
    expect(() =>
      generatedToolArguments(operation, "acme", "api", { org: "other" }),
    ).toThrow("Unknown input field");
  });

  it("overrides inherited parameters and keeps path/query/header names separate", () => {
    const op = generate().operations[0]!;
    expect(
      op.command.flags.find((f) => f.name === "limit")?.schema,
    ).toMatchObject({ default: 5 });
    expect(new Set(generate().operations.map((o) => o.tool.name)).size).toBe(3);
    expect(
      generatedCallArguments(op, "acme", "pets", [
        "--path-id",
        "a/b",
        "--query-limit",
        "5",
        "--query-tags",
        '["cat","dog"]',
        "--header-x-region",
        "eu",
      ]),
    ).toEqual({
      org: "acme",
      project: "pets",
      method: "GET",
      path: "/pets/{id}",
      pathParams: { id: "a/b" },
      query: { limit: 5, tags: ["cat", "dog"] },
      headers: { "x-region": "eu" },
    });
    expect(() => generatedCallArguments(op, "a", "b", [])).toThrow(
      "Missing required flag",
    );
    expect(() => generatedCallArguments(op, "a", "b", ["--wat", "x"])).toThrow(
      "Unknown or repeated",
    );
    expect(() =>
      generatedCallArguments(op, "a", "b", ["--query-limit", "bad"]),
    ).toThrow("valid JSON");
  });
  it.each([
    [{ $ref: "https://never-fetch.invalid/schema" }, "unsupported_reference"],
    [{ $ref: "#/components/schemas/missing" }, "unresolved_reference"],
    [{ $dynamicRef: "#node" }, "unsupported_schema_keyword"],
  ])(
    "reports unsupported schemas rather than widening them",
    (schema, code) => {
      const result = generate(withBody(schema));
      expect(result.operations).toEqual([]);
      expect(result.diagnostics).toEqual([{ identity: "POST /test", code }]);
      expect(result.markdown).toContain(code);
    },
  );
  it("fails recursive refs visibly, resolves escaped local names, and preserves oneOf", () => {
    expect(generate().operations[1]!.tool.inputSchema).toMatchObject({
      properties: {
        body: {
          properties: {
            name: { enum: ["cat", "dog"] },
            kind: { oneOf: [{ const: "young" }, { const: "old" }] },
          },
        },
      },
    });
    const spec = withBody(
      { $ref: "#/components/schemas/Node" },
      {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { child: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    );
    expect(generate(spec).diagnostics[0]?.code).toBe("recursive_reference");
  });
  it("normalizes OpenAPI 3.0 nullable and exclusive bounds", async () => {
    const result = generate(
      withBody(
        { type: "number", minimum: 1, exclusiveMinimum: true, nullable: true },
        { openapi: "3.0.3" },
      ),
    );
    await expect(JSON.stringify(result, null, 2) + "\n").toMatchFileSnapshot(
      "./fixtures/nullable.golden.txt",
    );
  });
  it("preserves ref siblings as intersections", () => {
    const spec = withBody(
      { $ref: "#/components/schemas/Base", maxLength: 3 },
      { components: { schemas: { Base: { type: "string", minLength: 2 } } } },
    );
    expect(generate(spec).operations[0]?.tool.inputSchema).toMatchObject({
      properties: {
        body: { allOf: [{ minLength: 2, type: "string" }, { maxLength: 3 }] },
      },
    });
  });
  it.each([
    [
      { in: "cookie", name: "session", schema: { type: "string" } },
      "unsupported_parameter_location",
    ],
    [
      { in: "header", name: "Authorization", schema: { type: "string" } },
      "reserved_header",
    ],
    [
      {
        in: "query",
        name: "filter",
        style: "deepObject",
        schema: { type: "object" },
      },
      "unsupported_parameter_schema",
    ],
  ])("exposes unsupported parameter diagnostics", (parameter, code) => {
    expect(
      generate({
        openapi: "3.1.0",
        paths: {
          "/test": { get: { "x-zevium-cost": 0, parameters: [parameter] } },
        },
      }).diagnostics[0]?.code,
    ).toBe(code);
  });
  it("bounds expanded strings before repeated refs can allocate large output", () => {
    const spec = withBody(
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            `p${i}`,
            { $ref: "#/components/schemas/Large" },
          ]),
        ),
      },
      {
        components: {
          schemas: {
            Large: { type: "string", description: "x".repeat(30_000) },
          },
        },
      },
    );
    expect(() => generate(spec)).toThrow("output_size_limit");
  });
  it("does not silently widen malformed schemas or path-item refs", () => {
    expect(generate(withBody({ type: "wat" })).diagnostics[0]?.code).toBe(
      "invalid_schema",
    );
    expect(() =>
      generate({
        openapi: "3.1.0",
        paths: { "/ref": { $ref: "https://never-fetch.invalid" } },
      }),
    ).toThrow("unsupported_path_item_reference");
  });

  it("bounds input, output, depth, and operation count", () => {
    expect(() =>
      generate({ ...representativeSpec, description: "x".repeat(400_000) }),
    ).toThrow("393216");
    expect(() =>
      generate(
        withBody({
          type: "string",
          description: "x".repeat(MAX_GENERATED_BYTES),
        }),
      ),
    ).toThrow("output_size_limit");
    let schema: unknown = { type: "string" };
    for (let n = 0; n < 40; n++) schema = { type: "array", items: schema };
    expect(() => generate(withBody(schema))).toThrow("complexity_limit");
    expect(() =>
      generate({
        openapi: "3.1.0",
        paths: Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [
            `/p${i}`,
            { get: { "x-zevium-cost": 0 } },
          ]),
        ),
      }),
    ).toThrow("operation_limit");
  });
});
