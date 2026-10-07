/** Public call reference only. Never serialize raw operations or components. */
import type { ParsedOpenApiSpec } from "@zevium/shared";
import { endpointsFromSpec } from "./discovery";

type ObjectMap = Record<string, unknown>;
type Kind = "schema" | "parameter" | "requestBody" | "response" | "example";
const GROUPS: Record<Kind, string> = {
  schema: "schemas",
  parameter: "parameters",
  requestBody: "requestBodies",
  response: "responses",
  example: "examples",
};
const record = (value: unknown): value is ObjectMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const map = (): ObjectMap => Object.create(null) as ObjectMap;

/** Keep local component refs + only reachable, allowlisted definitions. No IO. */
export function apiDocsFromSpec(spec: ParsedOpenApiSpec) {
  const components = map();
  const pending = new Map<
    string,
    { kind: Kind; name: string; value: unknown }
  >();
  let nodes = 0;
  function visit(depth: number) {
    // Spec bytes are already capped by parseSpec. Bound recursive schema/data walks too.
    if (depth > 64 || ++nodes > 50_000)
      throw new Error("API reference too complex");
  }
  function data(value: unknown, depth: number): unknown {
    visit(depth);
    if (Array.isArray(value)) return value.map((v) => data(v, depth + 1));
    if (record(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, data(v, depth + 1)]),
      );
    }
    return value;
  }
  function target(ref: unknown, kind: Kind) {
    if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
    let pointer: string;
    try {
      // URI fragment encoding wraps JSON Pointer escaping; decode in that order.
      pointer = decodeURIComponent(ref.slice(1));
    } catch {
      return undefined;
    }
    const parts = pointer.split("/");
    if (
      parts.length !== 4 ||
      parts[0] !== "" ||
      parts[1] !== "components" ||
      parts[2] !== GROUPS[kind]
    )
      return undefined;
    // JSON Pointer escaping only; external and arbitrary document refs are not exposed.
    if (/~(?![01])/u.test(parts[3]!)) return undefined;
    const name = parts[3]!.replace(/~1/g, "/").replace(/~0/g, "~");
    const group = spec.components?.[GROUPS[kind]];
    const value =
      record(group) && Object.hasOwn(group, name) ? group[name] : undefined;
    return { ref, name, value };
  }
  function reference(value: ObjectMap, kind: Kind, out: ObjectMap) {
    const found = target(value.$ref, kind);
    if (!found) return;
    out.$ref = found.ref;
    if (!pending.has(found.ref))
      pending.set(found.ref, { kind, name: found.name, value: found.value });
  }
  function fields(
    value: ObjectMap,
    out: ObjectMap,
    names: string[],
    type: "string" | "boolean" | "number",
  ) {
    for (const key of names)
      if (typeof value[key] === type) out[key] = value[key];
  }
  function examples(value: ObjectMap, out: ObjectMap, depth: number) {
    if (Object.hasOwn(value, "example"))
      out.example = data(value.example, depth + 1);
    if (record(value.examples)) {
      out.examples = Object.fromEntries(
        Object.entries(value.examples).map(([name, example]) => [
          name,
          project(example, "example", depth + 1),
        ]),
      );
    }
  }
  function content(value: unknown, depth: number): ObjectMap {
    const out = map();
    if (!record(value)) return out;
    for (const [mediaType, media] of Object.entries(value)) {
      if (!record(media) || !mediaType.includes("/") || /^x-/i.test(mediaType))
        continue;
      visit(depth);
      const item = map();
      if (Object.hasOwn(media, "schema"))
        item.schema = project(media.schema, "schema", depth + 1);
      examples(media, item, depth);
      out[mediaType] = item;
    }
    return out;
  }
  function project(value: unknown, kind: Kind, depth: number): unknown {
    visit(depth);
    if (kind === "schema" && typeof value === "boolean") return value;
    if (!record(value)) return map();
    const out = map();
    reference(value, kind, out);
    fields(value, out, ["description"], "string");
    if (kind === "schema") {
      fields(value, out, ["title", "format", "pattern"], "string");
      fields(
        value,
        out,
        ["nullable", "readOnly", "writeOnly", "deprecated", "uniqueItems"],
        "boolean",
      );
      fields(
        value,
        out,
        [
          "multipleOf",
          "maximum",
          "minimum",
          "maxLength",
          "minLength",
          "maxItems",
          "minItems",
          "maxProperties",
          "minProperties",
          "minContains",
          "maxContains",
        ],
        "number",
      );
      for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
        if (typeof value[key] === "number" || typeof value[key] === "boolean")
          out[key] = value[key];
      }
      if (
        typeof value.type === "string" ||
        (Array.isArray(value.type) &&
          value.type.every((v) => typeof v === "string"))
      )
        out.type = value.type;
      if (
        Array.isArray(value.required) &&
        value.required.every((v) => typeof v === "string")
      )
        out.required = value.required;
      // These are payload data, not OpenAPI metadata. Preserve their JSON keys verbatim.
      for (const key of ["enum", "const", "default", "example", "examples"]) {
        if (Object.hasOwn(value, key)) out[key] = data(value[key], depth + 1);
      }
      for (const key of [
        "properties",
        "patternProperties",
        "dependentSchemas",
      ]) {
        if (record(value[key]))
          out[key] = Object.fromEntries(
            Object.entries(value[key]).map(([name, schema]) => [
              name,
              project(schema, "schema", depth + 1),
            ]),
          );
      }
      for (const key of [
        "items",
        "additionalProperties",
        "unevaluatedProperties",
        "contains",
        "propertyNames",
        "not",
        "if",
        "then",
        "else",
      ]) {
        if (Object.hasOwn(value, key))
          out[key] = project(value[key], "schema", depth + 1);
      }
      for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
        if (Array.isArray(value[key]))
          out[key] = value[key].map((v) => project(v, "schema", depth + 1));
      }
    } else if (kind === "parameter") {
      fields(value, out, ["name", "in", "style"], "string");
      fields(
        value,
        out,
        [
          "required",
          "deprecated",
          "allowEmptyValue",
          "explode",
          "allowReserved",
        ],
        "boolean",
      );
      if (Object.hasOwn(value, "schema"))
        out.schema = project(value.schema, "schema", depth + 1);
      if (record(value.content))
        out.content = content(value.content, depth + 1);
      examples(value, out, depth);
    } else if (kind === "example") {
      fields(value, out, ["summary"], "string");
      if (Object.hasOwn(value, "value"))
        out.value = data(value.value, depth + 1);
      // externalValue may contain upstream addresses/credentials; never fetch or expose it.
    } else {
      if (kind === "requestBody") fields(value, out, ["required"], "boolean");
      if (record(value.content))
        out.content = content(value.content, depth + 1);
      // Response links, callbacks, security, servers, and vendor extensions are not call docs.
    }
    return out;
  }
  function parameterIdentity(raw: unknown): string | undefined {
    const seen = new Set<string>();
    let value = raw;
    while (record(value)) {
      if (typeof value.name === "string" && typeof value.in === "string")
        return JSON.stringify([value.in, value.name]);
      const found = target(value.$ref, "parameter");
      if (!found || seen.has(found.ref)) return undefined;
      seen.add(found.ref);
      value = found.value;
    }
    return undefined;
  }
  const endpoints = endpointsFromSpec(spec).map((endpoint) => {
    const pathItem = spec.paths[endpoint.path]!;
    const operation =
      pathItem[endpoint.method.toLowerCase() as keyof typeof pathItem];
    // Endpoint helper returns only real HTTP operations.
    if (!record(operation)) return endpoint;
    const out: ObjectMap = { ...endpoint };
    fields(operation, out, ["operationId", "description"], "string");
    const merged = new Map<string, unknown>();
    let anonymous = 0;
    for (const values of [pathItem.parameters, operation.parameters]) {
      if (!Array.isArray(values)) continue;
      for (const parameter of values) {
        merged.set(
          parameterIdentity(parameter) ?? `anonymous:${anonymous++}`,
          parameter,
        );
      }
    }
    if (merged.size)
      out.parameters = [...merged.values()].map((v) =>
        project(v, "parameter", 0),
      );
    if (Object.hasOwn(operation, "requestBody"))
      out.requestBody = project(operation.requestBody, "requestBody", 0);
    if (record(operation.responses))
      out.responses = Object.fromEntries(
        Object.entries(operation.responses)
          .filter(([status]) =>
            /^(?:[1-5](?:[0-9]{2}|XX)|default)$/.test(status),
          )
          .map(([status, response]) => [
            status,
            project(response, "response", 0),
          ]),
      );
    return out;
  });
  // Iteration includes newly discovered refs; visited map prevents recursive expansion.
  for (const { kind, name, value } of pending.values()) {
    const groupName = GROUPS[kind];
    const group = (components[groupName] ??= map()) as ObjectMap;
    if (value !== undefined) group[name] = project(value, kind, 0);
  }
  return {
    endpoints,
    ...(Object.keys(components).length ? { components } : {}),
  };
}
