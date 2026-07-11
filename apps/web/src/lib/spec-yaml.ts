import { parse as parseYaml } from "yaml";

export type YamlConvertResult =
  | { ok: true; json: string; convertedFromYaml: boolean }
  | { ok: false; error: string };

/**
 * Detect non-JSON OpenAPI paste/import, parse YAML, emit pretty JSON.
 * Storage stays canonical JSON.
 */
export function convertSpecInputToJson(text: string): YamlConvertResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, json: "", convertedFromYaml: false };
  }

  try {
    JSON.parse(trimmed);
    // Already JSON — pretty-print only when it was compact/messy? Keep as-is for editor.
    return { ok: true, json: text, convertedFromYaml: false };
  } catch {
    // fall through to YAML
  }

  try {
    const doc = parseYaml(trimmed) as unknown;
    if (doc === null || typeof doc !== "object") {
      return {
        ok: false,
        error: "YAML root must be an object",
      };
    }
    return {
      ok: true,
      json: `${JSON.stringify(doc, null, 2)}\n`,
      convertedFromYaml: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not parse as JSON or YAML: ${message}`,
    };
  }
}

/** True when text looks like YAML (not JSON) — leading non-{/[ after strip. */
export function looksLikeYaml(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return true;
}
