import { parseDocument } from "yaml";

export const MAX_YAML_INPUT_BYTES = 512 * 1024;
export const MAX_YAML_LINES = 20_000;
export const MAX_YAML_ALIASES = 20;
export const MAX_EXPANDED_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_NODES = 50_000;
const MAX_EXPANDED_DEPTH = 64;

export type YamlConvertResult =
  | { ok: true; json: string; convertedFromYaml: boolean }
  | { ok: false; error: string };

const encoder = new TextEncoder();

function assertYamlInputBounded(text: string): void {
  if (encoder.encode(text).byteLength > MAX_YAML_INPUT_BYTES) {
    throw new Error("YAML input exceeds safe size limit");
  }
  let lines = 1;
  let indicators = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines > MAX_YAML_LINES) {
      throw new Error("YAML input has too many lines");
    }
    const char = text[index];
    if ((char === "*" || char === "&") && index > 0) {
      const previous = text[index - 1]!;
      if (/\s|[,[{]/.test(previous)) indicators += 1;
      if (indicators > MAX_YAML_ALIASES * 2) {
        throw new Error("YAML aliases exceed safe complexity limit");
      }
    }
  }
}

function assertExpandedJsonBounded(value: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const active = new WeakSet<object>();

  const addBytes = (text: string) => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > MAX_EXPANDED_SPEC_BYTES) {
      throw new Error("Expanded YAML exceeds safe size limit");
    }
  };
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_EXPANDED_NODES || depth > MAX_EXPANDED_DEPTH) {
      throw new Error("Expanded YAML exceeds safe complexity limit");
    }
    if (item === null || typeof item === "boolean") {
      addBytes(String(item));
      return;
    }
    if (typeof item === "string") {
      addBytes(JSON.stringify(item));
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("YAML contains a non-finite number");
      }
      addBytes(String(item));
      return;
    }
    if (typeof item !== "object") {
      throw new Error("YAML contains an unsupported value");
    }
    if (active.has(item)) throw new Error("YAML contains a cyclic alias");
    const prototype = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error("YAML contains an unsupported object");
    }
    active.add(item);
    if (Array.isArray(item)) {
      addBytes("[]");
      for (const child of item) visit(child, depth + 1);
    } else {
      addBytes("{}");
      for (const [key, child] of Object.entries(item)) {
        addBytes(JSON.stringify(key));
        visit(child, depth + 1);
      }
    }
    active.delete(item);
  };

  visit(value, 0);
}

/** Parse bounded YAML and reject alias expansion before JSON serialization. */
function parseBoundedYaml(text: string): unknown {
  assertYamlInputBounded(text);
  const document = parseDocument(text, {
    schema: "core",
    merge: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw document.errors[0];
  const value = document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown;
  assertExpandedJsonBounded(value);
  return value;
}

/** Detect non-JSON OpenAPI input, parse bounded YAML, emit pretty JSON. */
export function convertSpecInputToJson(text: string): YamlConvertResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, json: "", convertedFromYaml: false };
  }

  try {
    JSON.parse(trimmed);
    return { ok: true, json: text, convertedFromYaml: false };
  } catch {
    // Fall through to bounded YAML parsing.
  }

  try {
    const value = parseBoundedYaml(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "YAML root must be an object" };
    }
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (encoder.encode(json).byteLength > MAX_EXPANDED_SPEC_BYTES) {
      throw new Error("Expanded YAML exceeds safe size limit");
    }
    return { ok: true, json, convertedFromYaml: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not parse as JSON or YAML: ${message}`,
    };
  }
}

/** True when text looks like YAML (not JSON). */
export function looksLikeYaml(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}
