import { describe, expect, it } from "vitest";
import {
  initialFormValue,
  formValueFits,
  operationParameters,
  schemaToForm,
  serializeRequestParameters,
  validateFormValue,
} from "./request-form";

const document = {
  components: {
    schemas: {
      Count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
      "a/b~c": { type: "string", enum: ["red", "blue"] },
      Node: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Node" } },
      },
      Loop: { $ref: "#/components/schemas/Loop" },
    },
  },
};

describe("schema to form", () => {
  it("maps nested fields, required flags, arrays, enums, defaults and descriptions", () => {
    const node = schemaToForm(
      {
        type: "object",
        required: ["count", "nested"],
        properties: {
          count: {
            $ref: "#/components/schemas/Count",
            description: "How many",
          },
          nested: {
            type: "object",
            properties: {
              colors: {
                type: "array",
                items: { $ref: "#/components/schemas/a~1b~0c" },
                default: ["red"],
              },
            },
          },
          optional: { type: "boolean" },
          serverId: { type: "string", readOnly: true },
        },
      },
      document,
    );
    expect(node.kind).toBe("object");
    expect(
      node.properties?.map((p) => [p.name, p.required, p.node.kind]),
    ).toEqual([
      ["count", true, "integer"],
      ["nested", true, "object"],
      ["optional", false, "boolean"],
    ]);
    expect(node.properties?.[0]?.node.schema.description).toBe("How many");
    expect(initialFormValue(node)).toEqual({
      count: 2,
      nested: { colors: ["red"] },
    });
  });
  it.each(["oneOf", "anyOf"])("maps %s variants", (keyword) => {
    const node = schemaToForm({
      [keyword]: [
        { type: "string", title: "Text", default: "abc" },
        { type: "number" },
      ],
    });
    expect(node.kind).toBe("variant");
    expect(node.variants).toHaveLength(2);
    expect(initialFormValue(node)).toBe("abc");
  });
  it.each([
    [{ $ref: "#/components/schemas/Node" }, "Recursive"],
    [{ $ref: "#/components/schemas/Loop" }, "Reference"],
    [{ $ref: "https://example.com/schema" }, "Reference"],
    [{ type: "string", pattern: "unsafe-pattern" }, "Unsupported"],
    [{ allOf: [{ type: "object" }] }, "Combined"],
    [{ type: "object", additionalProperties: { type: "string" } }, "Free-form"],
    [{ type: ["string", "null"] }, "Nullable"],
    [{ type: "array", items: [{ type: "string" }] }, "unsupported"],
  ])("explains raw fallback for %j", (schema, reason) => {
    const node = schemaToForm(schema, document);
    expect(node.kind).toBe("raw");
    expect(node.reason).toContain(reason);
  });
  it("bounds wide and deep schemas", () => {
    expect(
      schemaToForm({
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 151 }, (_, i) => [
            String(i),
            { type: "string" },
          ]),
        ),
      }).kind,
    ).toBe("raw");
    let schema: unknown = { type: "string" };
    for (let i = 0; i < 10; i++) schema = { type: "array", items: schema };
    expect(schemaToForm(schema).reason).toContain("limit");
  });
  it("preserves zero, false, empty, null defaults and examples", () => {
    for (const value of [0, false, "", null])
      expect(initialFormValue(schemaToForm({ default: value }))).toBe(value);
    expect(
      initialFormValue(schemaToForm({ type: "string", example: "example" })),
    ).toBe("example");
    expect(
      initialFormValue(schemaToForm({ type: "number" }), false),
    ).toBeUndefined();
  });
});

describe("validation", () => {
  it("checks nested required, type, enum and numeric constraints with pointer paths", () => {
    const schema = {
      type: "object",
      required: ["name", "count"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 3 },
        count: { $ref: "#/components/schemas/Count" },
        colors: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: ["red", "blue"] },
        },
      },
    };
    const errors = validateFormValue(
      schema,
      { count: 0, colors: ["green", "green"], extra: true },
      document,
    ).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: "/name", message: "This value is required." },
        { path: "/count", message: "Must be at least 1." },
        { path: "/colors/0", message: "Choose one of the allowed values." },
        { path: "/colors", message: "Items must be unique." },
        { path: "/extra", message: "This property is not allowed." },
      ]),
    );
    expect(validateFormValue({ type: "integer" }, 1.1).errors).toHaveLength(1);
    expect(
      validateFormValue(
        { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 2 },
        0,
      ).errors,
    ).toHaveLength(1);
    expect(
      validateFormValue({ type: "number", multipleOf: 0.1 }, 0.3).errors,
    ).toEqual([]);
  });
  it("does not treat false, zero or empty string as absent", () => {
    for (const [type, value] of [
      ["boolean", false],
      ["number", 0],
      ["string", ""],
    ])
      expect(validateFormValue({ type }, value, {}, true).errors).toEqual([]);
    expect(validateFormValue({}, undefined, {}, true).errors).toHaveLength(1);
    expect(
      validateFormValue({ type: "string", nullable: true }, null).errors,
    ).toEqual([]);
    expect(
      validateFormValue({ type: ["null", "string"] }, null).errors,
    ).toEqual([]);
  });
  it("enforces oneOf exclusivity, anyOf and allOf in raw mode", () => {
    const variants = [{ type: "integer" }, { type: "number" }];
    expect(
      validateFormValue({ oneOf: variants }, 1).errors[0]?.message,
    ).toContain("exactly one");
    expect(validateFormValue({ anyOf: variants }, 1).errors).toEqual([]);
    expect(
      validateFormValue({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 4).errors,
    ).toHaveLength(1);
    expect(
      validateFormValue({ not: { const: "no" } }, "no").errors,
    ).toHaveLength(1);
  });
  it("validates recursive data without following cycles forever; reports unsupported assertions", () => {
    expect(
      validateFormValue(
        { $ref: "#/components/schemas/Node" },
        { child: { child: {} } },
        document,
      ),
    ).toEqual({ errors: [], warnings: [] });
    expect(
      validateFormValue({ $ref: "#/components/schemas/Loop" }, {}, document)
        .warnings,
    ).toHaveLength(1);
    expect(
      validateFormValue({ type: "string", pattern: "x" }, "a").warnings[0]
        ?.message,
    ).toContain("pattern");
    let value: unknown = {};
    for (let i = 0; i < 40; i++) value = { child: value };
    expect(
      validateFormValue({ $ref: "#/components/schemas/Node" }, value, document)
        .warnings[0]?.message,
    ).toContain("limit");
  });
  it("ignores required readOnly properties and handles prototype names as data", () => {
    expect(
      validateFormValue(
        {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", readOnly: true } },
        },
        {},
      ).errors,
    ).toEqual([]);
    const schema: unknown = JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}',
    );
    expect(validateFormValue(schema, {}).errors).toHaveLength(1);
    expect(
      validateFormValue(schema, JSON.parse('{"__proto__":"safe"}')).errors,
    ).toEqual([]);
  });
});

describe("parameters and serialization", () => {
  it("resolves parameter refs, inherits and overrides by location/name, uses parameter examples", () => {
    const parameters = operationParameters(
      [
        { in: "query", name: "count", schema: { type: "string" } },
        { in: "path", name: "count", schema: { type: "integer" } },
      ],
      [{ $ref: "#/components/parameters/Count" }],
      {
        components: {
          parameters: {
            Count: {
              in: "query",
              name: "count",
              example: 3,
              schema: { type: "integer" },
            },
          },
        },
      },
    );
    expect(
      parameters.map((p) => [p.key, p.node.kind, p.initialValue, p.required]),
    ).toEqual([
      ["query:count", "integer", 3, false],
      ["path:count", "integer", undefined, true],
    ]);
  });
  it("serializes encoded paths, repeated queries, zero, false and headers", () => {
    const ps = operationParameters(
      [],
      [
        { in: "path", name: "id", schema: { type: "string" } },
        {
          in: "query",
          name: "tags",
          schema: { type: "array", items: { type: "string" } },
        },
        { in: "query", name: "count", schema: { type: "number" } },
        { in: "query", name: "active", schema: { type: "boolean" } },
        { in: "header", name: "X-Region", schema: { type: "string" } },
      ],
      {},
    );
    expect(
      serializeRequestParameters("/things/{id}", ps, {
        "path:id": "a/b ?#",
        "query:tags": ["one", "two"],
        "query:count": 0,
        "query:active": false,
        "header:X-Region": "eu",
      }),
    ).toEqual({
      path: "/things/a%2Fb%20%3F%23?tags=one&tags=two&count=0&active=false",
      headers: { "X-Region": "eu" },
      errors: [],
    });
  });
  it.each([
    [
      "query",
      "deepObject",
      true,
      { role: "admin" },
      "/x?value%5Brole%5D=admin",
    ],
    ["query", "pipeDelimited", false, [1, 2], "/x?value=1%7C2"],
    ["query", "spaceDelimited", false, [1, 2], "/x?value=1+2"],
    ["query", "form", false, { a: 1, b: 2 }, "/x?value=a%2C1%2Cb%2C2"],
    ["path", "label", true, [1, 2], "/x/.1.2"],
    ["path", "matrix", true, [1, 2], "/x/;value=1;value=2"],
    ["path", "simple", true, { a: 1, b: 2 }, "/x/a=1,b=2"],
  ])("serializes %s %s", (location, style, explode, value, expected) => {
    const ps = operationParameters(
      [],
      [{ in: location, name: "value", style, explode, schema: {} }],
      {},
    );
    expect(
      serializeRequestParameters(
        location === "path" ? "/x/{value}" : "/x",
        ps,
        { [`${location}:value`]: value },
      ).path,
    ).toBe(expected);
  });
  it("refuses unsupported serialization and undeclared path placeholders", () => {
    const ps = operationParameters(
      [],
      [{ in: "query", name: "q", allowReserved: true, schema: {} }],
      {},
    );
    expect(
      serializeRequestParameters("/x/{id}", ps, { "query:q": "x" }).errors,
    ).toHaveLength(2);
    const nested = operationParameters(
      [],
      [{ in: "query", name: "q", schema: {} }],
      {},
    );
    expect(
      serializeRequestParameters("/x", nested, { "query:q": { child: {} } })
        .errors[0]?.message,
    ).toContain("Nested");
  });
});

it("rejects path traversal, missing path values, and malformed Unicode without throwing", () => {
  const ps = operationParameters(
    [],
    [{ in: "path", name: "id", schema: { type: "string" } }],
    {},
  );
  for (const value of ["", ".", "..", "\ud800"])
    expect(
      serializeRequestParameters("/items/{id}", ps, { "path:id": value }).errors
        .length,
    ).toBeGreaterThan(0);
});

it("infers scalar enum controls and falls back for constrained union siblings", () => {
  expect(schemaToForm({ enum: ["a", "b"] }).kind).toBe("string");
  expect(schemaToForm({ const: 0 }).kind).toBe("number");
  expect(
    schemaToForm({
      type: "object",
      properties: { common: { type: "string" } },
      oneOf: [{ properties: { a: { type: "string" } } }],
    }).reason,
  ).toContain("sibling constraints");
});
it("allows omitted optional parameters even when their serialization is unsupported", () => {
  const ps = operationParameters(
    [],
    [{ in: "query", name: "q", allowReserved: true }],
    {},
  );
  expect(serializeRequestParameters("/x", ps, {}).errors).toEqual([]);
});

it("bounds raw value rendering and preserves special header names", () => {
  expect(formValueFits(Array.from({ length: 101 }, () => 1))).toBe(false);
  expect(formValueFits({ rows: [1, 2, 3] })).toBe(true);
  const ps = operationParameters(
    [],
    [{ in: "header", name: "__proto__", schema: { type: "string" } }],
    {},
  );
  const result = serializeRequestParameters("/x", ps, {
    "header:__proto__": "value",
  });
  expect(Object.hasOwn(result.headers, "__proto__")).toBe(true);
  expect(result.headers.__proto__).toBe("value");
});
