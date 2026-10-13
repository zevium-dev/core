import { resolveLocalJsonPointer } from "../json-pointer.js";

const MAX_WORK = 12_000;

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
  const visit = (depth: number, count = 1) => {
    nodes += count;
    if (nodes > MAX_WORK || depth > 32)
      throw new GenerationError("complexity_limit");
  };
  // Reserve each field before reading/copying it, and bound key-array allocation
  // before sorting. Ignored extensions never have their values read or copied.
  function keys(value: Record<string, unknown>, depth: number): string[] {
    const result: string[] = [];
    for (const key in value) {
      visit(depth);
      if (Object.hasOwn(value, key)) result.push(key);
    }
    return result.sort();
  }
  function project(
    value: Record<string, unknown>,
    supported: ReadonlySet<string>,
    depth: number,
    strict = false,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key in value) {
      visit(depth);
      if (!Object.hasOwn(value, key) || key === "$ref") continue;
      if (supported.has(key)) out[key] = value[key];
      else if (
        strict &&
        !key.startsWith("x-") &&
        key !== "xml" &&
        key !== "externalDocs"
      )
        throw new GenerationError("unsupported_schema_keyword");
    }
    return out;
  }
  function reference(ref: string): unknown {
    // The pointer resolver caps paths at 64 segments. Charge the maximum before
    // decoding/splitting the pointer or reading the referenced document.
    visit(0, 64);
    const target = resolveLocalJsonPointer(ref, document);
    if (target === undefined) throw new GenerationError("unresolved_reference");
    return target;
  }
  function data(value: unknown, depth = 0): unknown {
    visit(depth);
    if (typeof value === "string") return budget(value);
    if (Array.isArray(value)) {
      visit(depth, value.length);
      return value.map((v) => data(v, depth + 1));
    }
    if (record(value))
      return Object.fromEntries(
        keys(value, depth).map((k) => [budget(k), data(value[k], depth + 1)]),
      );
    return value;
  }
  const referenceFields = new Set([
    "name",
    "in",
    "description",
    "required",
    "schema",
    "example",
    "content",
    "allowReserved",
    "style",
    "explode",
  ]);
  function resolve(value: unknown, refs: readonly string[] = []): unknown {
    visit(refs.length);
    if (!record(value)) return value;
    const ref = value.$ref;
    const siblings = project(value, referenceFields, refs.length);
    if (ref === undefined) return siblings;
    if (typeof ref !== "string" || !ref.startsWith("#/components/"))
      throw new GenerationError("unsupported_reference");
    if (refs.includes(ref) || refs.length >= 32)
      throw new GenerationError("recursive_reference");
    const resolved = resolve(reference(ref), [...refs, ref]);
    if (Object.keys(siblings).length === 0) return resolved;
    if (!record(resolved))
      throw new GenerationError("unsupported_reference_siblings");
    // Both sides have already been projected; charge the merge before spreading.
    visit(
      refs.length,
      Object.keys(resolved).length + Object.keys(siblings).length,
    );
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
  const schemaFields = new Set([
    ...annotations,
    ...scalar,
    ...maps,
    ...singles,
    ...arrays,
    "nullable",
  ]);
  function schema(
    value: unknown,
    depth = 0,
    refs: readonly string[] = [],
  ): JsonSchema {
    visit(depth);
    if (typeof value === "boolean") return value;
    if (!record(value)) throw new GenerationError("invalid_schema");
    const ref = value.$ref;
    const projected = project(value, schemaFields, depth, true);
    if (ref !== undefined) {
      if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/"))
        throw new GenerationError("unsupported_reference");
      if (refs.includes(ref)) throw new GenerationError("recursive_reference");
      const base = schema(reference(ref), depth + 1, [...refs, ref]);
      if (!Object.keys(projected).length) return base;
      // JSON Schema siblings intersect, never overwrite referenced constraints.
      return { allOf: [base, schema(projected, depth + 1, refs)] };
    }
    for (const key of ["type", "required"]) {
      const entries = projected[key];
      if (Array.isArray(entries)) visit(depth, entries.length);
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
      projected.type !== undefined &&
      !(typeof projected.type === "string"
        ? types.has(projected.type)
        : Array.isArray(projected.type) &&
          projected.type.length > 0 &&
          projected.type.every((v) => typeof v === "string" && types.has(v)))
    )
      throw new GenerationError("invalid_schema");
    if (
      projected.required !== undefined &&
      !(
        Array.isArray(projected.required) &&
        projected.required.every((v) => typeof v === "string")
      )
    )
      throw new GenerationError("invalid_schema");
    if (
      projected.enum !== undefined &&
      !(Array.isArray(projected.enum) && projected.enum.length > 0)
    )
      throw new GenerationError("invalid_schema");
    if (
      projected.nullable !== undefined &&
      typeof projected.nullable !== "boolean"
    )
      throw new GenerationError("invalid_schema");
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(projected).sort()) {
      const v = projected[key];
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
          keys(v, depth).map((k) => [budget(k), schema(v[k], depth + 1, refs)]),
        );
      } else if (singles.has(key)) out[key] = schema(v, depth + 1, refs);
      else if (arrays.has(key) && Array.isArray(v)) {
        visit(depth, v.length);
        out[key] = v.map((s) => schema(s, depth + 1, refs));
      } else throw new GenerationError("unsupported_schema_keyword");
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
    return projected.nullable === true
      ? { anyOf: [out, { type: "null" }] }
      : out;
  }
  return { schema, resolve, data };
}
