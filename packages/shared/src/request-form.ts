import { resolveLocalJsonPointer } from "./json-pointer.js";

export type FormSchema = Record<string, unknown>;
export type FormNode = {
  kind:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "variant"
    | "raw";
  schema: FormSchema;
  properties?: { name: string; required: boolean; node: FormNode }[];
  item?: FormNode;
  variants?: FormNode[];
  reason?: string;
};
export type FormIssue = { path: string; message: string };
export type FormValidation = { errors: FormIssue[]; warnings: FormIssue[] };
export type RequestParameter = {
  key: string;
  name: string;
  location: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: unknown;
  node: FormNode;
  initialValue: unknown;
  style: string;
  explode: boolean;
  unsupported?: string;
};

export function isFormObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
export const formPath = (parent: string, key: string | number) =>
  `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function resolve(schema: unknown, document: unknown): unknown {
  const seen = new Set<string>();
  while (isFormObject(schema) && typeof schema.$ref === "string") {
    if (seen.has(schema.$ref) || seen.size >= 32) return undefined;
    seen.add(schema.$ref);
    const target = resolveLocalJsonPointer(schema.$ref, document);
    if (!isFormObject(target)) return target;
    const { $ref: _, ...siblings } = schema;
    schema = { ...target, ...siblings };
  }
  return schema;
}

// Unknown assertions are explicit, never silently presented as fully validated.
const annotations = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "xml",
  "externalDocs",
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "discriminator",
]);
const assertions = new Set([
  "type",
  "nullable",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
]);
function unsupportedKeywords(schema: FormSchema): string[] {
  return Object.keys(schema).filter(
    (key) =>
      !annotations.has(key) &&
      !assertions.has(key) &&
      !key.startsWith("x-") &&
      key !== "format",
  );
}
function schemaType(schema: FormSchema): unknown {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== "null");
    return types.length === 1 ? types[0] : undefined;
  }
  const choices = Array.isArray(schema.enum)
    ? schema.enum
    : own(schema, "const")
      ? [schema.const]
      : [];
  const firstType = typeof choices[0];
  const inferred =
    choices.length &&
    ["string", "number", "boolean"].includes(firstType) &&
    choices.every((item) => typeof item === firstType)
      ? firstType
      : undefined;
  return (
    schema.type ??
    (schema.properties ? "object" : schema.items ? "array" : inferred)
  );
}

/** Bounded, pure UI projection. The original schema remains the validation contract. */
export function schemaToForm(
  schema: unknown,
  document: unknown = {},
): FormNode {
  let nodes = 0;
  const walk = (input: unknown, depth: number, refs: Set<string>): FormNode => {
    const resolved = resolve(input, document);
    const s = isFormObject(resolved) ? resolved : {};
    const raw = (reason: string): FormNode => ({
      kind: "raw",
      schema: s,
      reason,
    });
    if (++nodes > 150 || depth > 8)
      return raw(
        "Schema exceeds the form limit (150 fields / 8 levels). Use raw JSON.",
      );
    if (isFormObject(input) && typeof input.$ref === "string") {
      if (refs.has(input.$ref)) return raw("Recursive schema. Use raw JSON.");
      refs = new Set(refs).add(input.$ref);
    }
    if (resolved === undefined)
      return raw(
        "Reference cannot be resolved locally. Use raw JSON; reference validation is unavailable.",
      );
    if (!isFormObject(resolved)) return raw("This schema needs raw JSON.");
    const unsupported = unsupportedKeywords(s);
    if (unsupported.length)
      return raw(
        `Unsupported schema keywords: ${unsupported.join(", ")}. Use raw JSON; these constraints are not checked here.`,
      );
    if (s.allOf || s.not)
      return raw("Combined schema (allOf / not). Use raw JSON.");
    if (
      s.nullable === true ||
      (Array.isArray(s.type) && s.type.includes("null")) ||
      (s.enum instanceof Array &&
        s.enum.some((value) => value === null || typeof value === "object"))
    )
      return raw("Nullable or complex values need raw JSON.");
    const variants = s.oneOf ?? s.anyOf;
    if (Array.isArray(variants)) {
      if (!variants.length || variants.length > 12 || (s.oneOf && s.anyOf))
        return raw("This variant schema needs raw JSON.");
      const { oneOf: _, anyOf: __, ...base } = s;
      if (Object.keys(base).some((key) => assertions.has(key)))
        return raw(
          "Variants with sibling constraints need raw JSON to preserve the complete contract.",
        );
      const mapped = variants.map((variant) =>
        walk(
          isFormObject(variant) ? { ...base, ...variant } : variant,
          depth + 1,
          refs,
        ),
      );
      const fallback = mapped.find((node) => node.kind === "raw");
      return fallback
        ? raw(fallback.reason!)
        : { kind: "variant", schema: s, variants: mapped };
    }
    const type = schemaType(s);
    if (type === "object") {
      if (!isFormObject(s.properties))
        return raw("Free-form object. Use raw JSON to enter its keys.");
      if (
        Array.isArray(s.required) &&
        s.required.some(
          (name) =>
            typeof name === "string" && !own(s.properties as FormSchema, name),
        )
      )
        return raw(
          "A required property has no declared field schema. Use raw JSON.",
        );
      const entries = Object.entries(s.properties);
      if (entries.length > 150)
        return raw("Schema exceeds the form limit (150 fields). Use raw JSON.");
      const properties = entries
        .filter(
          ([, child]) =>
            !(
              isFormObject(resolve(child, document)) &&
              (resolve(child, document) as FormSchema).readOnly === true
            ),
        )
        .map(([name, child]) => ({
          name,
          required: Array.isArray(s.required) && s.required.includes(name),
          node: walk(child, depth + 1, refs),
        }));
      const fallback = properties.find(({ node }) => node.kind === "raw");
      return fallback
        ? raw(`${fallback.name}: ${fallback.node.reason}`)
        : { kind: "object", schema: s, properties };
    }
    if (type === "array") {
      if (Array.isArray(s.items) || s.items === undefined)
        return raw("Array item schema is unsupported. Use raw JSON.");
      const item = walk(s.items, depth + 1, refs);
      return item.kind === "raw"
        ? raw(item.reason!)
        : { kind: "array", schema: s, item };
    }
    if (
      type === "string" ||
      type === "number" ||
      type === "integer" ||
      type === "boolean"
    ) {
      if (s.format === "binary" || s.format === "byte")
        return raw("Binary uploads are unavailable in this playground.");
      return { kind: type, schema: s };
    }
    return raw("Unspecified or unsupported value type. Use raw JSON.");
  };
  return walk(schema, 0, new Set());
}

/** Only declared defaults/examples are seeded. Optional values otherwise stay absent. */
export function initialFormValue(node: FormNode, required = true): unknown {
  const s = node.schema;
  for (const key of ["default", "example", "const"])
    if (own(s, key)) return s[key];
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (!required) return undefined;
  if (node.kind === "object")
    return Object.fromEntries(
      (node.properties ?? [])
        .map((p) => [p.name, initialFormValue(p.node, p.required)])
        .filter(([, value]) => value !== undefined),
    );
  if (node.kind === "array") return [];
  if (node.kind === "boolean") return false;
  if (node.kind === "variant") return initialFormValue(node.variants![0]!);
  return undefined;
}

/** Keep raw values with excessive breadth/depth out of the recursive UI. */
export function formValueFits(value: unknown): boolean {
  let visits = 0;
  const walk = (current: unknown, depth: number): boolean => {
    if (++visits > 500 || depth > 8) return false;
    if (Array.isArray(current))
      return (
        current.length <= 100 && current.every((item) => walk(item, depth + 1))
      );
    if (isFormObject(current)) {
      const values = Object.values(current);
      return (
        values.length <= 150 && values.every((item) => walk(item, depth + 1))
      );
    }
    return true;
  };
  return walk(value, 0);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (isFormObject(a) && isFormObject(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => own(b, key) && equal(a[key], b[key]))
    );
  return false;
}

/** Interpret supported assertions without eval/code generation (safe under the web CSP).
 * Untrusted schema/value traversal is bounded; incomplete validation is reported.
 */
export function validateFormValue(
  schema: unknown,
  value: unknown,
  document: unknown = {},
  required = false,
  path = "",
): FormValidation {
  let visits = 0;
  const walk = (
    input: unknown,
    current: unknown,
    needed: boolean,
    at: string,
    depth: number,
  ): FormValidation => {
    const result: FormValidation = { errors: [], warnings: [] };
    const error = (message: string) =>
      result.errors.push({ path: at, message });
    const warning = (message: string) =>
      result.warnings.push({ path: at, message });
    const merge = (next: FormValidation) => {
      result.errors.push(...next.errors);
      result.warnings.push(...next.warnings);
    };
    if (++visits > 5000 || depth > 32) {
      warning(
        "Validation limit reached; check this value against the published schema.",
      );
      return result;
    }
    if (typeof current === "symbol") {
      error("Enter valid JSON.");
      return result;
    }
    if (current === undefined) {
      if (needed) error("This value is required.");
      return result;
    }
    const s = resolve(input, document);
    if (s === false) {
      error("This value is not allowed.");
      return result;
    }
    if (s === true) return result;
    if (!isFormObject(s)) {
      warning("Schema could not be resolved; only JSON syntax is checked.");
      return result;
    }
    const unknown = unsupportedKeywords(s);
    if (unknown.length) warning(`Not checked here: ${unknown.join(", ")}.`);
    if (s.nullable === true && current === null) return result;
    if (Array.isArray(s.enum) && !s.enum.some((item) => equal(item, current)))
      error("Choose one of the allowed values.");
    if (own(s, "const") && !equal(s.const, current))
      error(`Value must be ${JSON.stringify(s.const)}.`);
    for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
      const variants = s[keyword];
      if (!Array.isArray(variants)) continue;
      if (variants.length > 150) {
        warning("Too many schema variants to validate here.");
        continue;
      }
      const checked = variants.map((variant) =>
        walk(variant, current, true, at, depth + 1),
      );
      result.warnings.push(...checked.flatMap((r) => r.warnings));
      if (keyword === "allOf") checked.forEach(merge);
      else {
        const matches = checked.filter((r) => !r.errors.length).length;
        if (matches === 0) error("Value must match a schema variant.");
        else if (keyword === "oneOf" && matches !== 1)
          error("Value must match exactly one schema variant.");
      }
    }
    if (s.not !== undefined) {
      const checked = walk(s.not, current, true, at, depth + 1);
      result.warnings.push(...checked.warnings);
      if (!checked.errors.length && !checked.warnings.length)
        error("Value matches a disallowed schema.");
    }
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const matches = (type: unknown) =>
      type === "null"
        ? current === null
        : type === "object"
          ? isFormObject(current)
          : type === "array"
            ? Array.isArray(current)
            : type === "integer"
              ? typeof current === "number" && Number.isInteger(current)
              : type === "number"
                ? typeof current === "number" && Number.isFinite(current)
                : typeof current === type;
    if (types.length && !types.some(matches)) {
      error(`Enter ${types.join(" or ")} value.`);
      return result;
    }
    if (typeof current === "number") {
      const min =
        typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum : s.minimum;
      const max =
        typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum : s.maximum;
      const exclusiveMin =
        s.exclusiveMinimum === true || typeof s.exclusiveMinimum === "number";
      const exclusiveMax =
        s.exclusiveMaximum === true || typeof s.exclusiveMaximum === "number";
      if (
        typeof min === "number" &&
        (exclusiveMin ? current <= min : current < min)
      )
        error(`Must be ${exclusiveMin ? "greater than" : "at least"} ${min}.`);
      if (
        typeof max === "number" &&
        (exclusiveMax ? current >= max : current > max)
      )
        error(`Must be ${exclusiveMax ? "less than" : "at most"} ${max}.`);
      if (
        typeof s.multipleOf === "number" &&
        s.multipleOf > 0 &&
        Math.abs(current / s.multipleOf - Math.round(current / s.multipleOf)) >
          1e-8
      )
        error(`Must be a multiple of ${s.multipleOf}.`);
    }
    const range = (size: number, min: unknown, max: unknown, unit: string) => {
      if (typeof min === "number" && size < min)
        error(`Use at least ${min} ${unit}.`);
      if (typeof max === "number" && size > max)
        error(`Use at most ${max} ${unit}.`);
    };
    if (typeof current === "string")
      range([...current].length, s.minLength, s.maxLength, "characters");
    if (Array.isArray(current)) {
      range(current.length, s.minItems, s.maxItems, "items");
      if (current.length > 500) {
        warning("Only arrays up to 500 items are validated here.");
        return result;
      }
      if (
        s.uniqueItems === true &&
        current.some((item, i) =>
          current.slice(0, i).some((other) => equal(item, other)),
        )
      )
        error("Items must be unique.");
      if (s.items !== undefined)
        current.forEach((item, i) =>
          merge(walk(s.items, item, true, formPath(at, i), depth + 1)),
        );
    }
    if (isFormObject(current)) {
      const keys = Object.keys(current);
      range(keys.length, s.minProperties, s.maxProperties, "properties");
      if (keys.length > 500) {
        warning("Only objects up to 500 properties are validated here.");
        return result;
      }
      const properties = isFormObject(s.properties) ? s.properties : {};
      const requiredNames = Array.isArray(s.required)
        ? s.required.filter((key): key is string => typeof key === "string")
        : [];
      for (const name of new Set([
        ...Object.keys(properties),
        ...requiredNames,
      ])) {
        const child = own(properties, name) ? properties[name] : {};
        if (
          isFormObject(resolve(child, document)) &&
          (resolve(child, document) as FormSchema).readOnly === true
        )
          continue;
        merge(
          walk(
            child,
            own(current, name) ? current[name] : undefined,
            requiredNames.includes(name),
            formPath(at, name),
            depth + 1,
          ),
        );
      }
      for (const name of keys.filter((key) => !own(properties, key))) {
        if (s.additionalProperties === false)
          result.errors.push({
            path: formPath(at, name),
            message: "This property is not allowed.",
          });
        else if (isFormObject(s.additionalProperties))
          merge(
            walk(
              s.additionalProperties,
              current[name],
              true,
              formPath(at, name),
              depth + 1,
            ),
          );
      }
    }
    return result;
  };
  return walk(schema, value, required, path, 0);
}

/** Path-item parameters are inherited; operation entries override by (in, name). */
export function operationParameters(
  pathParameters: unknown,
  operationParameters: unknown,
  document: unknown,
): RequestParameter[] {
  const result = new Map<string, RequestParameter>();
  for (const input of [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(Array.isArray(operationParameters) ? operationParameters : []),
  ]) {
    const p = resolve(input, document);
    if (
      !isFormObject(p) ||
      typeof p.name !== "string" ||
      !["path", "query", "header"].includes(String(p.in))
    )
      continue;
    const location = p.in as RequestParameter["location"];
    const schema = p.schema ?? {};
    const node = schemaToForm(schema, document);
    const style =
      typeof p.style === "string"
        ? p.style
        : location === "query"
          ? "form"
          : "simple";
    const validStyles =
      location === "path"
        ? ["simple", "label", "matrix"]
        : location === "query"
          ? ["form", "spaceDelimited", "pipeDelimited", "deepObject"]
          : ["simple"];
    const namedExample = isFormObject(p.examples)
      ? Object.values(p.examples)
          .map((e) => resolve(e, document))
          .find((e) => isFormObject(e) && own(e, "value"))
      : undefined;
    result.set(`${location}:${p.name}`, {
      key: `${location}:${p.name}`,
      name: p.name,
      location,
      required: location === "path" || p.required === true,
      description:
        typeof p.description === "string" ? p.description : undefined,
      schema,
      node,
      style,
      explode: typeof p.explode === "boolean" ? p.explode : style === "form",
      initialValue: own(p, "example")
        ? p.example
        : isFormObject(namedExample)
          ? namedExample.value
          : initialFormValue(node, location === "path" || p.required === true),
      ...(!validStyles.includes(style) || p.content || p.allowReserved === true
        ? {
            unsupported:
              "This parameter's content, style, or allowReserved serialization is unsupported.",
          }
        : {}),
    });
  }
  return [...result.values()];
}

/** OpenAPI scalar/flat-array/flat-object parameter serialization. Nested values fail explicitly. */
export function serializeRequestParameters(
  template: string,
  parameters: RequestParameter[],
  values: Record<string, unknown>,
): { path: string; headers: Record<string, string>; errors: FormIssue[] } {
  let path = template;
  const query = new URLSearchParams();
  const headers = new Map<string, string>();
  const errors: FormIssue[] = [];
  for (const p of parameters) {
    const encode = (v: unknown) => {
      try {
        return encodeURIComponent(String(v));
      } catch {
        errors.push({ path: p.key, message: "Use valid Unicode text." });
        return "";
      }
    };
    const value = own(values, p.key) ? values[p.key] : undefined;
    if (value === undefined && !p.required) continue;
    if (p.unsupported) {
      errors.push({ path: p.key, message: p.unsupported });
      continue;
    }
    if (value === undefined) continue;
    if (
      p.location === "path" &&
      (value === "" || value === "." || value === "..")
    ) {
      errors.push({
        path: p.key,
        message: "Enter a nonempty path value other than a dot or double dot.",
      });
      continue;
    }
    if (typeof value === "symbol") {
      errors.push({ path: p.key, message: "Enter valid JSON." });
      continue;
    }
    if (value === null) {
      errors.push({
        path: p.key,
        message:
          "Null parameter serialization is undefined. Omit this optional value or use a non-null value.",
      });
      continue;
    }
    const array = Array.isArray(value);
    const object = isFormObject(value);
    const entries = object ? Object.entries(value) : [];
    const items = array ? value : object ? entries.flat() : [value];
    if (items.some((item) => item !== null && typeof item === "object")) {
      errors.push({
        path: p.key,
        message:
          "Nested parameter values cannot be serialized here. Use a client with this parameter's documented serialization.",
      });
      continue;
    }
    if (p.location === "query") {
      if (p.style === "deepObject") {
        if (!object)
          errors.push({
            path: p.key,
            message: "deepObject requires an object value.",
          });
        else
          entries.forEach(([key, item]) =>
            query.append(`${p.name}[${key}]`, String(item)),
          );
      } else if (p.style === "form" && p.explode && array)
        value.forEach((item) => query.append(p.name, String(item)));
      else if (p.style === "form" && p.explode && object)
        entries.forEach(([key, item]) => query.append(key, String(item)));
      else
        query.append(
          p.name,
          items
            .map(String)
            .join(
              p.style === "pipeDelimited"
                ? "|"
                : p.style === "spaceDelimited"
                  ? " "
                  : ",",
            ),
        );
    } else {
      const transform = p.location === "path" ? encode : String;
      let text =
        object && p.explode
          ? entries
              .map(([key, item]) => `${transform(key)}=${transform(item)}`)
              .join(
                p.style === "label" ? "." : p.style === "matrix" ? ";" : ",",
              )
          : items
              .map(transform)
              .join(p.style === "label" && p.explode ? "." : ",");
      if (p.location === "header") headers.set(p.name, text);
      else {
        if (p.style === "label") text = `.${text}`;
        if (p.style === "matrix")
          text =
            object && p.explode
              ? `;${text}`
              : array && p.explode
                ? value
                    .map((item) => `;${encode(p.name)}=${encode(item)}`)
                    .join("")
                : `;${encode(p.name)}=${text}`;
        if (text === "." || text === "..") {
          errors.push({
            path: p.key,
            message:
              "This value would change the endpoint path. Choose another value.",
          });
          continue;
        }
        path = path.replaceAll(`{${p.name}}`, text);
      }
    }
  }
  for (const match of path.matchAll(/\{([^{}/]+)\}/g))
    errors.push({
      path: `path:${match[1]}`,
      message: "Path parameter is required or missing from the published spec.",
    });
  return {
    path: query.size ? `${path}?${query.toString()}` : path,
    headers: Object.fromEntries(headers),
    errors,
  };
}
