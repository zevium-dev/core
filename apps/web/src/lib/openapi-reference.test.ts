import { describe, expect, it } from "vitest";

import {
  appendQueryParameters,
  buildRequestPath,
  parameterKey,
  parsePublishedEndpoints,
  readableJsonResponse,
  readableSuccessResponse,
  sanitizedGatewayErrorResponse,
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

  it("inherits referenced path parameters and lets operations override by name and location", () => {
    const [endpoint] = parsePublishedEndpoints(
      JSON.stringify({
        openapi: "3.1.0",
        components: {
          parameters: {
            ItemId: {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", example: "shared-id" },
            },
          },
        },
        paths: {
          "/items/{id}": {
            parameters: [
              { $ref: "#/components/parameters/ItemId" },
              {
                name: "x-tenant",
                in: "header",
                description: "Shared tenant",
                schema: { type: "string", default: "shared" },
              },
            ],
            get: {
              parameters: [
                {
                  name: "x-tenant",
                  in: "header",
                  description: "Operation tenant",
                  required: true,
                  schema: { type: "string", default: "operation" },
                },
                {
                  name: "limit",
                  in: "query",
                  schema: { type: "integer", default: 25 },
                },
              ],
            },
          },
        },
      }),
    );

    expect(endpoint?.parameters).toEqual([
      expect.objectContaining({
        key: "path:id",
        required: true,
        initialValue: "shared-id",
      }),
      expect.objectContaining({
        key: "header:x-tenant",
        description: "Operation tenant",
        required: true,
        initialValue: "operation",
      }),
      expect.objectContaining({
        key: "query:limit",
        type: "integer",
        initialValue: "25",
      }),
    ]);
  });

  it("resolves chained and RFC 6901-escaped component references", () => {
    const [endpoint] = parsePublishedEndpoints(
      JSON.stringify({
        openapi: "3.1.0",
        components: {
          parameters: {
            Alias: { $ref: "#/components/parameters/owner~1id~0parameter" },
            "owner/id~parameter": {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", example: "escaped-id" },
            },
          },
          requestBodies: {
            Alias: { $ref: "#/components/requestBodies/JSON%7E0body" },
            "JSON~body": {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", example: { ok: true } },
                },
              },
            },
          },
          responses: {
            Alias: { $ref: "#/components/responses/good~1response" },
            "good/response": {
              description: "Escaped response",
              content: {
                "application/json": { example: { id: "ok" } },
              },
            },
          },
        },
        paths: {
          "/items/{id}": {
            parameters: [{ $ref: "#/components/parameters/Alias" }],
            post: {
              requestBody: { $ref: "#/components/requestBodies/Alias" },
              responses: {
                "200": { $ref: "#/components/responses/Alias" },
              },
            },
          },
        },
      }),
    );

    expect(endpoint?.parameters[0]).toMatchObject({
      key: "path:id",
      initialValue: "escaped-id",
    });
    expect(endpoint).toMatchObject({
      requestBodyRequired: true,
      requestContentType: "application/json",
      requestBodyExample: '{\n  "ok": true\n}',
    });
    expect(endpoint?.responses[0]).toMatchObject({
      description: "Escaped response",
      example: '{\n  "id": "ok"\n}',
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

describe("readableSuccessResponse", () => {
  it("renders HTML as bounded text without accepting binary bytes", () => {
    expect(
      readableSuccessResponse("<h1>safe text</h1>", "text/html; charset=utf-8"),
    ).toBe("<h1>safe text</h1>");
    expect(readableSuccessResponse("abcdef", "text/plain", 3)).toBe(
      "abc\n… [response truncated]",
    );
    expect(readableSuccessResponse("binary", "image/png")).toBeNull();
  });
});

describe("sanitizedGatewayErrorResponse", () => {
  it("renders only an allowlisted gateway envelope with matching request ID", () => {
    expect(
      sanitizedGatewayErrorResponse(
        JSON.stringify({
          error: "upstream_timeout",
          requestId: "req_safe",
          stack: "secret stack",
          token: "secret token",
        }),
        "application/json",
        "req_safe",
      ),
    ).toBe(
      JSON.stringify(
        {
          error: "upstream_timeout",
          message: "The upstream service did not respond in time.",
          requestId: "req_safe",
        },
        null,
        2,
      ),
    );
  });

  it("rejects arbitrary upstream JSON, unknown codes, and mismatched IDs", () => {
    expect(
      sanitizedGatewayErrorResponse(
        '{"error":"database exploded","stack":"secret"}',
        "application/json",
        "req_1",
      ),
    ).toBeNull();
    expect(
      sanitizedGatewayErrorResponse(
        '{"error":"upstream_error","requestId":"spoofed"}',
        "application/json",
        "req_1",
      ),
    ).toBeNull();
    expect(
      sanitizedGatewayErrorResponse(
        '{"error":"upstream_error","requestId":"req_1"}',
        "text/plain",
        "req_1",
      ),
    ).toBeNull();
  });
});
