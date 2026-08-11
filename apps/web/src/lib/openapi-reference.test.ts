import { describe, expect, it } from "vitest";

import {
  appendQueryParameters,
  buildRequestPath,
  parameterKey,
  parsePublishedEndpoints,
  readableJsonResponse,
} from "./openapi-reference";

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Search", version: "1.0.0" },
  paths: {
    "/items/{id}": {
      get: {
        operationId: "getItem",
        summary: "Get item",
        description: "Returns one item.",
        tags: ["items"],
        "x-zevium-cost": 7,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", example: "item 1" },
          },
          {
            name: "expand",
            in: "query",
            schema: { type: "boolean", default: false },
          },
          {
            name: "x-locale",
            in: "header",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string", example: "item_1" } },
                },
              },
            },
          },
        },
      },
    },
  },
});

describe("parsePublishedEndpoints", () => {
  it("extracts pricing, parameters, operation metadata, and responses", () => {
    const [endpoint] = parsePublishedEndpoints(SPEC);
    expect(endpoint).toMatchObject({
      id: "get:/items/{id}",
      operationId: "getItem",
      description: "Returns one item.",
      cost: 7,
      tags: ["items"],
    });
    expect(endpoint?.parameters).toEqual([
      expect.objectContaining({
        key: "path:id",
        required: true,
        initialValue: "item 1",
      }),
      expect.objectContaining({
        key: "query:expand",
        initialValue: "false",
      }),
      expect.objectContaining({ key: "header:x-locale" }),
    ]);
    expect(endpoint?.responses[0]).toMatchObject({
      status: "200",
      description: "Found",
      contentTypes: ["application/json"],
      example: '{\n  "id": "item_1"\n}',
    });
  });
});

describe("request URL helpers", () => {
  const endpoint = parsePublishedEndpoints(SPEC)[0]!;

  it("encodes path segments and non-empty query values", () => {
    const values = {
      [parameterKey("path", "id")]: "item 1/2",
      [parameterKey("query", "expand")]: "true",
    };
    const path = buildRequestPath(endpoint.path, values);
    expect(path).toBe("/items/item%201%2F2");
    expect(
      appendQueryParameters(
        `https://gateway.test${path}`,
        endpoint.parameters,
        values,
      ),
    ).toBe("https://gateway.test/items/item%201%2F2?expand=true");
  });
});

describe("readableJsonResponse", () => {
  it("formats valid JSON only when declared as JSON and bounded", () => {
    expect(
      readableJsonResponse('{"error":"bad"}', "application/problem+json"),
    ).toBe('{\n  "error": "bad"\n}');
    expect(readableJsonResponse("secret", "text/plain")).toBeNull();
    expect(
      readableJsonResponse('{"ok":true}', "application/json", 2),
    ).toBeNull();
  });
});
