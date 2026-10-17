import type { GeneratedOperation } from "./index.js";

/** Bind generated flags to operation.call.tool arguments, never an upstream URL. */
export function generatedCallArguments(
  operation: GeneratedOperation,
  org: string,
  project: string,
  argv: readonly string[],
): Record<string, unknown> {
  const inputs = new Map<string, unknown>();
  const byFlag = new Map(
    operation.command.flags.map((flag) => [flag.flag, flag]),
  );
  for (let i = 0; i < argv.length; i += 2) {
    const flag = byFlag.get(argv[i]!);
    if (!flag || inputs.has(flag.flag))
      throw new Error("Unknown or repeated flag; read command help");
    const raw = argv[i + 1];
    if (raw === undefined)
      throw new Error("Missing flag value; read command help");
    let value: unknown = raw;
    if (flag.encoding === "json") {
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        throw new Error("Flag requires valid JSON");
      }
    }
    inputs.set(flag.flag, value);
  }
  const values: Record<string, unknown> = {};
  const groups = {
    pathParams: new Map<string, unknown>(),
    query: new Map<string, unknown>(),
    headers: new Map<string, unknown>(),
  };
  for (const flag of operation.command.flags) {
    if (!inputs.has(flag.flag)) continue;
    const value = inputs.get(flag.flag);
    if (flag.location === "body") values.body = value;
    else groups[flag.location].set(flag.name, value);
  }
  for (const [location, valuesMap] of Object.entries(groups))
    if (valuesMap.size) values[location] = Object.fromEntries(valuesMap);
  return generatedToolArguments(operation, org, project, values);
}

/** Shared binding for future listing-scoped MCP tools and the CLI. */
export function generatedToolArguments(
  operation: GeneratedOperation,
  org: string,
  project: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  // operation.call.tool names the MCP tool; it is not an argument. Fixed headers merge below.
  const args: Record<string, unknown> = {
    org,
    project,
    method: operation.call.method,
    path: operation.call.path,
  };
  for (const key of Object.keys(values)) {
    if (!["pathParams", "query", "headers", "body"].includes(key))
      throw new Error("Unknown input field");
  }
  for (const location of ["pathParams", "query", "headers", "body"] as const) {
    const flags = operation.command.flags.filter(
      (f) => f.location === location,
    );
    if (location === "body") {
      if (Object.hasOwn(values, "body")) {
        if (!flags.length) throw new Error("Unexpected body");
        // call_api_* treat strings as raw bytes and null as no body. Preserve JSON semantics.
        args.body =
          typeof values.body === "string" || values.body === null
            ? JSON.stringify(values.body)
            : values.body;
      } else if (flags.some((f) => f.required))
        throw new Error("Missing required flag: --body");
      continue;
    }
    const raw = values[location];
    if (
      raw !== undefined &&
      (raw === null || typeof raw !== "object" || Array.isArray(raw))
    )
      throw new Error("Parameter groups must be objects");
    const entries = Object.entries(raw ?? {});
    const mapped = new Map<string, unknown>(
      location === "headers"
        ? Object.entries(operation.call.headers ?? {})
        : [],
    );
    for (const [name, value] of entries) {
      const flag = flags.find((f) => f.name === name);
      if (!flag) throw new Error("Unknown parameter");
      const schema = flag.schema;
      const validScalar = (value: unknown) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value));
      if (
        typeof schema === "boolean" ||
        (!validScalar(value) &&
          !(
            location === "query" &&
            Array.isArray(value) &&
            value.every(validScalar)
          ))
      )
        throw new Error("Invalid parameter value");
      if (
        (schema.type === "string" && typeof value !== "string") ||
        (schema.type === "boolean" && typeof value !== "boolean") ||
        (schema.type === "number" && typeof value !== "number") ||
        (schema.type === "integer" && !Number.isInteger(value)) ||
        (schema.type === "array" && !Array.isArray(value))
      )
        throw new Error("Invalid parameter type");
      mapped.set(name, value);
    }
    for (const flag of flags)
      if (flag.required && !entries.some(([name]) => name === flag.name))
        throw new Error(`Missing required flag: ${flag.flag}`);
    if (mapped.size) args[location] = Object.fromEntries(mapped);
  }
  return args;
}
