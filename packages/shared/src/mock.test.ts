import { describe, expect, it } from "vitest";
import { parseSpec } from "./openapi.js";
import { generateMockResponse } from "./mock.js";

function specWith(paths: Record<string, unknown>, components?: unknown) {
  return parseSpec(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Demo", version: "1.0.0" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths,
      components,
    }),
  );
}

describe("generateMockResponse", () => {
  it("returns null for an unknown operation", () => {
    const spec = specWith({ "/health": { get: {} } });
    expect(generateMockResponse(spec, "/nope", "get")).toBeNull();
    expect(generateMockResponse(spec, "/health", "post")).toBeNull();
  });

  it("falls back to {} when the operation has no 200 json schema", () => {
    const spec = specWith({ "/health": { get: {} } });
    const result = generateMockResponse(spec, "/health", "get");
    expect(result).toEqual({
      status: 200,
      body: {},
      contentType: "application/json",
    });
  });

  it("prefers a schema-level example over synthesis", () => {
    const spec = specWith({
      "/users/{id}": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    example: { id: "u_123", name: "Ada" },
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/users/{id}", "get");
    expect(result?.body).toEqual({ id: "u_123", name: "Ada" });
    expect(result?.status).toBe(200);
    expect(result?.contentType).toBe("application/json");
  });

  it("prefers schema-level examples (array form) over synthesis", () => {
    const spec = specWith({
      "/ping": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    examples: [{ ok: true }],
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/ping", "get");
    expect(result?.body).toEqual({ ok: true });
  });

  it("prefers schema-level examples (named-object form) over synthesis", () => {
    const spec = specWith({
      "/ping": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    examples: { basic: { value: { ok: true } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/ping", "get");
    expect(result?.body).toEqual({ ok: true });
  });

  it("synthesizes primitives, enums, arrays, and nested objects from types", () => {
    const spec = specWith({
      "/widgets": {
        post: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      count: { type: "integer" },
                      price: { type: "number" },
                      active: { type: "boolean" },
                      status: { type: "string", enum: ["ready", "pending"] },
                      tags: { type: "array", items: { type: "string" } },
                      owner: {
                        type: "object",
                        properties: {
                          email: { type: "string", format: "email" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/widgets", "post");
    expect(result?.body).toEqual({
      id: "string",
      count: 0,
      price: 0,
      active: true,
      status: "ready",
      tags: ["string"],
      owner: { email: "user@example.com" },
    });
  });

  it("is format-aware for date-time / uuid / uri strings", () => {
    const spec = specWith({
      "/stamps": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      at: { type: "string", format: "date-time" },
                      day: { type: "string", format: "date" },
                      id: { type: "string", format: "uuid" },
                      link: { type: "string", format: "uri" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/stamps", "get") as {
      body: Record<string, unknown>;
    };
    expect(result.body.at).toBe("2024-01-01T00:00:00.000Z");
    expect(result.body.day).toBe("2024-01-01");
    expect(result.body.id).toBe("00000000-0000-0000-0000-000000000000");
    expect(result.body.link).toBe("https://example.com");
  });

  it("resolves $ref against components.schemas one level", () => {
    const spec = specWith(
      {
        "/users/{id}": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
      {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              age: { type: "integer" },
            },
          },
        },
      },
    );
    const result = generateMockResponse(spec, "/users/{id}", "get");
    expect(result?.body).toEqual({ id: "string", age: 0 });
  });

  it("leaves an unresolvable $ref as an empty object rather than throwing", () => {
    const spec = specWith({
      "/x": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Missing" },
                },
              },
            },
          },
        },
      },
    });
    const result = generateMockResponse(spec, "/x", "get");
    expect(result?.body).toEqual({});
  });

  it("caps recursion depth on self-referential / deeply nested schemas", () => {
    const spec = specWith(
      {
        "/tree": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" },
                  },
                },
              },
            },
          },
        },
      },
      {
        schemas: {
          Node: {
            type: "object",
            properties: {
              label: { type: "string" },
              child: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
    );

    const result = generateMockResponse(spec, "/tree", "get");
    // Must terminate (no stack overflow / unbounded growth) from the cycle.
    expect(result).not.toBeNull();
    expect(JSON.stringify(result!.body).length).toBeLessThan(500);

    let cursor: unknown = result!.body;
    let depth = 0;
    while (isPlainObject(cursor) && "child" in cursor && depth < 10) {
      cursor = cursor.child;
      depth += 1;
    }
    // A real depth cap stops well short of an unbounded (10-deep) walk.
    expect(depth).toBeLessThan(10);
  });
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
