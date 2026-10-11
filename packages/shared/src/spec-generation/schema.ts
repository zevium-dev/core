import { resolveLocalJsonPointer } from "../json-pointer.js";

export type JsonSchema = boolean | Record<string, unknown>;
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class GenerationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Deterministic, allowlisted JSON Schema projection. Never dereferences URLs. */
export function schemaProjector(document: unknown) {
  let nodes = 0;
  let stringBytes = 0;
  function budget(value: string): string {
    stringBytes += new TextEncoder().encode(value).byteLength;
    if (stringBytes > 196_608) throw new GenerationError("output_size_limit");
    return value;
  }
  const visit = (depth: number) => {
    if (++nodes > 12_000 || depth > 32)
      throw new GenerationError("complexity_limit");
  };
  function data(value: unknown, depth = 0): unknown {
    visit(depth);
    if (typeof value === "string") return budget(value);
    if (Array.isArray(value)) return value.map((v) => data(v, depth + 1));
    if (record(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [budget(k), data(value[k], depth + 1)]),
      );
    return value;
  }
  function resolve(value: unknown, refs: readonly string[] = []): unknown {
    if (!record(value) || value.$ref === undefined) return value;
    const ref = value.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/components/"))
      throw new GenerationError("unsupported_reference");
    if (refs.includes(ref) || refs.length >= 32)
      throw new GenerationError("recursive_reference");
    const target = resolveLocalJsonPointer(ref, document);
    if (target === undefined) throw new GenerationError("unresolved_reference");
    const siblings = Object.fromEntries(
      Object.entries(value).filter(([k]) => k !== "$ref"),
    );
    const resolved = resolve(target, [...refs, ref]);
    if (Object.keys(siblings).length === 0) return resolved;
    if (!record(resolved))
      throw new GenerationError("unsupported_reference_siblings");
    return { ...resolved, ...siblings };
  }
  const annotations = new Set([
    "title",
    "description",
    "default",
    "example",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "format",
  ]);
  const scalar = new Set([
    "type",
    "enum",
    "const",
    "required",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
  ]);
  const maps = new Set(["properties", "patternProperties", "dependentSchemas"]);
  const singles = new Set([
    "items",
    "additionalProperties",
    "not",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
  ]);
  const arrays = new Set(["allOf", "oneOf", "anyOf", "prefixItems"]);
  function schema(
    value: unknown,
    depth = 0,
    refs: readonly string[] = [],
  ): JsonSchema {
    visit(depth);
    if (typeof value === "boolean") return value;
    if (!record(value)) throw new GenerationError("invalid_schema");
    if (value.$ref !== undefined) {
      const ref = value.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/"))
        throw new GenerationError("unsupported_reference");
      if (refs.includes(ref)) throw new GenerationError("recursive_reference");
      const target = resolveLocalJsonPointer(ref, document);
      if (target === undefined)
        throw new GenerationError("unresolved_reference");
      const base = schema(target, depth + 1, [...refs, ref]);
      const siblings = Object.fromEntries(
        Object.entries(value).filter(([k]) => k !== "$ref"),
      );
      if (!Object.keys(siblings).length) return base;
      // JSON Schema siblings intersect, never overwrite referenced constraints.
      return { allOf: [base, schema(siblings, depth + 1, refs)] };
    }
    const types = new Set([
      "null",
      "boolean",
      "object",
      "array",
      "number",
      "integer",
      "string",
    ]);
    if (
      value.type !== undefined &&
      !(typeof value.type === "string"
        ? types.has(value.type)
        : Array.isArray(value.type) &&
          value.type.length > 0 &&
          value.type.every((v) => typeof v === "string" && types.has(v)))
    )
      throw new GenerationError("invalid_schema");
    if (
      value.required !== undefined &&
      !(
        Array.isArray(value.required) &&
        value.required.every((v) => typeof v === "string")
      )
    )
      throw new GenerationError("invalid_schema");
    if (
      value.enum !== undefined &&
      !(Array.isArray(value.enum) && value.enum.length > 0)
    )
      throw new GenerationError("invalid_schema");
    if (value.nullable !== undefined && typeof value.nullable !== "boolean")
      throw new GenerationError("invalid_schema");
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (key.startsWith("x-") || key === "xml" || key === "externalDocs")
        continue;
      if (key === "nullable") continue;
      if (
        ["title", "description", "format", "pattern"].includes(key) &&
        typeof v !== "string"
      )
        throw new GenerationError("invalid_schema");
      if (
        ["deprecated", "readOnly", "writeOnly", "uniqueItems"].includes(key) &&
        typeof v !== "boolean"
      )
        throw new GenerationError("invalid_schema");
      if (
        [
          "minimum",
          "maximum",
          "multipleOf",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minProperties",
          "maxProperties",
        ].includes(key) &&
        (typeof v !== "number" || !Number.isFinite(v))
      )
        throw new GenerationError("invalid_schema");
      if (
        [
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minProperties",
          "maxProperties",
        ].includes(key) &&
        (!Number.isInteger(v) || Number(v) < 0)
      )
        throw new GenerationError("invalid_schema");
      if (key === "multipleOf" && Number(v) <= 0)
        throw new GenerationError("invalid_schema");
      if (
        ["exclusiveMinimum", "exclusiveMaximum"].includes(key) &&
        typeof v !== "number" &&
        typeof v !== "boolean"
      )
        throw new GenerationError("invalid_schema");
      if (arrays.has(key) && (!Array.isArray(v) || v.length === 0))
        throw new GenerationError("invalid_schema");
      if (annotations.has(key) || scalar.has(key)) {
        Object.defineProperty(out, key, {
          value: data(v, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else if (maps.has(key) && record(v)) {
        out[key] = Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [budget(k), schema(v[k], depth + 1, refs)]),
        );
      } else if (singles.has(key)) out[key] = schema(v, depth + 1, refs);
      else if (arrays.has(key) && Array.isArray(v))
        out[key] = v.map((s) => schema(s, depth + 1, refs));
      else throw new GenerationError("unsupported_schema_keyword");
    }
    // OpenAPI 3.0's boolean bounds and nullable are not JSON Schema 2020-12.
    for (const [exclusive, bound] of [
      ["exclusiveMinimum", "minimum"],
      ["exclusiveMaximum", "maximum"],
    ] as const) {
      if (typeof out[exclusive] === "boolean") {
        if (out[exclusive] && typeof out[bound] === "number") {
          out[exclusive] = out[bound];
          delete out[bound];
        } else if (out[exclusive]) throw new GenerationError("invalid_schema");
        else delete out[exclusive];
      }
    }
    return value.nullable === true ? { anyOf: [out, { type: "null" }] } : out;
  }
  return { schema, resolve, data };
}
