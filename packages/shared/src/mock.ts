/**
 * Mock response generation for the gateway `/mock/*` route.
 * Builds an example JSON body from an operation's `responses["200"]`
 * `application/json` schema — no upstream call, no credits.
 */

import type { ParsedOpenApiSpec } from "./openapi.js";

export type GeneratedMockResponse = {
  status: 200;
  body: unknown;
  contentType: "application/json";
};

const MAX_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `components.schemas.<Name>` — one hop only, no chained/recursive $ref walk. */
function resolveRef(
  schema: Record<string, unknown>,
  components: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
  if (!match) return schema;
  const name = match[1]!;
  const schemas = isRecord(components) ? components.schemas : undefined;
  const target = isRecord(schemas) ? schemas[name] : undefined;
  return isRecord(target) ? target : schema;
}

function stringExample(schema: Record<string, unknown>): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  switch (format) {
    case "date-time":
      return "2024-01-01T00:00:00.000Z";
    case "date":
      return "2024-01-01";
    case "email":
      return "user@example.com";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "uri":
    case "url":
    case "hostname":
      return "https://example.com";
    default:
      return "string";
  }
}

/** Fallback value once recursion hits MAX_DEPTH — stops runaway/self-referential schemas. */
function depthCapValue(type: string): unknown {
  switch (type) {
    case "array":
      return [];
    case "string":
      return "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    default:
      return {};
  }
}

function inferType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "object";
}

/** Explicit example on a schema node — OpenAPI `example` or JSON-Schema-style `examples`. */
function explicitExample(
  schema: Record<string, unknown>,
): { found: true; value: unknown } | { found: false } {
  if ("example" in schema) return { found: true, value: schema.example };
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return { found: true, value: schema.examples[0] };
  }
  if (isRecord(schema.examples)) {
    const first = Object.values(schema.examples)[0];
    if (isRecord(first) && "value" in first) {
      return { found: true, value: first.value };
    }
  }
  return { found: false };
}

function synthesize(
  rawSchema: unknown,
  components: Record<string, unknown> | undefined,
  depth: number,
): unknown {
  if (!isRecord(rawSchema)) return null;

  const schema =
    typeof rawSchema.$ref === "string"
      ? resolveRef(rawSchema, components)
      : rawSchema;

  const explicit = explicitExample(schema);
  if (explicit.found) return explicit.value;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const type = inferType(schema);

  if (depth >= MAX_DEPTH) return depthCapValue(type);

  switch (type) {
    case "string":
      return stringExample(schema);
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array": {
      const item = synthesize(schema.items, components, depth + 1);
      return [item];
    }
    case "object":
    default: {
      if (isRecord(schema.properties)) {
        const out: Record<string, unknown> = {};
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          out[key] = synthesize(propSchema, components, depth + 1);
        }
        return out;
      }
      return {};
    }
  }
}

/** `op.responses["200"].content["application/json"].schema` — undefined if absent. */
function extractResponseSchema(op: unknown): unknown {
  if (!isRecord(op)) return undefined;
  const responses = op.responses;
  if (!isRecord(responses)) return undefined;
  const ok = responses["200"];
  if (!isRecord(ok)) return undefined;
  const content = ok.content;
  if (!isRecord(content)) return undefined;
  const media = content["application/json"];
  if (!isRecord(media)) return undefined;
  return media.schema;
}

/**
 * Build a mock 200 response for `pathTemplate`+`method` from the spec's
 * `responses["200"].content["application/json"].schema`. Prefers schema
 * `example`/`examples`, else synthesizes from `type` (depth-capped, one-hop
 * `$ref` resolution). Returns null when the operation itself is unknown —
 * callers (gateway `/mock` route) treat that as 404.
 */
export function generateMockResponse(
  spec: ParsedOpenApiSpec,
  pathTemplate: string,
  method: string,
): GeneratedMockResponse | null {
  const op = spec.paths[pathTemplate]?.[method.toLowerCase()];
  if (!op) return null;

  const schema = extractResponseSchema(op);
  const body =
    schema === undefined ? {} : synthesize(schema, spec.components, 0);

  return { status: 200, body, contentType: "application/json" };
}
