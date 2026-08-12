import { describe, expect, it } from "vitest";

import { exampleFromSchema, tryItBodyDefaults } from "./try-it";

describe("tryItBodyDefaults", () => {
  it("uses text media type and schema example", () => {
    expect(
      tryItBodyDefaults({
        requestBody: {
          content: {
            "text/plain": {
              schema: { type: "string", example: "# Hello" },
            },
          },
        },
      }),
    ).toEqual({ contentType: "text/plain", body: "# Hello" });
  });

  it("prefers JSON and serializes object examples", () => {
    expect(
      tryItBodyDefaults({
        requestBody: {
          content: {
            "text/plain": { example: "ignored" },
            "application/json": { example: { message: "hello" } },
          },
        },
      }),
    ).toEqual({
      contentType: "application/json",
      body: '{\n  "message": "hello"\n}',
    });
  });

  it("falls back to empty JSON body when request metadata is absent", () => {
    expect(tryItBodyDefaults({})).toEqual({
      contentType: "application/json",
      body: "{\n  \n}",
    });
  });

  it("generates a request example from object schemas", () => {
    expect(
      tryItBodyDefaults({
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  query: { type: "string", example: "weather" },
                  limit: { type: "integer", default: 10 },
                  active: { type: "boolean" },
                },
              },
            },
          },
        },
      }).body,
    ).toBe('{\n  "query": "weather",\n  "limit": 10,\n  "active": false\n}');
  });

  it("resolves local component schema references", () => {
    expect(
      tryItBodyDefaults(
        {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchRequest" },
              },
            },
          },
        },
        {
          schemas: {
            SearchRequest: {
              type: "object",
              properties: { query: { type: "string", example: "weather" } },
            },
          },
        },
      ).body,
    ).toBe('{\n  "query": "weather"\n}');
  });
});

describe("exampleFromSchema", () => {
  it("bounds recursive schemas", () => {
    const recursive: Record<string, unknown> = { type: "object" };
    recursive.properties = { child: recursive };
    expect(exampleFromSchema(recursive)).toEqual({
      child: { child: { child: { child: { child: {} } } } },
    });
  });
});
