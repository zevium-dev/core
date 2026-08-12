import type { OpenApiOperation } from "@zevium/shared";

export type TryItBodyDefaults = {
  contentType: string;
  body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeExample(value: unknown, contentType: string): string {
  if (typeof value === "string") return value;
  if (contentType.toLowerCase().includes("json")) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/** Build a bounded, deterministic example when a schema has no explicit one. */
export function exampleFromSchema(
  schema: unknown,
  depth = 0,
  components?: Record<string, unknown>,
): unknown {
  if (!isRecord(schema) || depth > 5) return undefined;
  if (typeof schema.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (schema.$ref.startsWith(prefix) && isRecord(components?.schemas)) {
      const name = decodeURIComponent(schema.$ref.slice(prefix.length));
      return exampleFromSchema(components.schemas[name], depth + 1, components);
    }
  }
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  if (schema.type === "object" || isRecord(schema.properties)) {
    if (!isRecord(schema.properties)) return {};
    const result: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(schema.properties)) {
      const value = exampleFromSchema(property, depth + 1, components);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  if (schema.type === "array") {
    const item = exampleFromSchema(schema.items, depth + 1, components);
    return item === undefined ? [] : [item];
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
    if (schema.format === "date") return "2026-01-01";
    return "string";
  }
  return undefined;
}

/** Derive playground media type and initial body from OpenAPI requestBody. */
export function tryItBodyDefaults(
  operation: OpenApiOperation,
  components?: Record<string, unknown>,
): TryItBodyDefaults {
  const requestBody = operation.requestBody;
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) {
    return { contentType: "application/json", body: "{\n  \n}" };
  }

  const content = requestBody.content;
  const selected =
    (isRecord(content["application/json"])
      ? (["application/json", content["application/json"]] as const)
      : Object.entries(content).find((entry) => isRecord(entry[1]))) ?? null;
  if (selected === null || !isRecord(selected[1])) {
    return { contentType: "application/json", body: "{\n  \n}" };
  }

  const [contentType, media] = selected;
  if ("example" in media) {
    return {
      contentType,
      body: serializeExample(media.example, contentType),
    };
  }
  if (isRecord(media.schema) && "example" in media.schema) {
    return {
      contentType,
      body: serializeExample(media.schema.example, contentType),
    };
  }
  if (isRecord(media.schema)) {
    const generated = exampleFromSchema(media.schema, 0, components);
    if (generated !== undefined) {
      return {
        contentType,
        body: serializeExample(generated, contentType),
      };
    }
  }
  return {
    contentType,
    body: contentType.toLowerCase().includes("json") ? "{\n  \n}" : "",
  };
}
