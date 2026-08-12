import { parseDocument } from "yaml";

import {
  MAX_EXPANDED_DEPTH,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_SPEC_BYTES,
  MAX_YAML_ALIASES,
  MAX_YAML_CPU_MS,
  type YamlFailureCode,
} from "./spec-yaml-limits";

export type YamlWorkerResult =
  { ok: true; json: string } | { ok: false; code: YamlFailureCode };

class BoundedYamlError extends Error {
  constructor(readonly code: YamlFailureCode) {
    super(code);
  }
}

const encoder = new TextEncoder();

/** Worker-only parser. Parser messages and source excerpts never leave isolate. */
export function parseYamlInWorker(text: string): YamlWorkerResult {
  const startedAt = performance.now();
  const checkCpu = () => {
    if (performance.now() - startedAt > MAX_YAML_CPU_MS) {
      throw new BoundedYamlError("cpu_limit");
    }
  };
  try {
    const document = parseDocument(text, {
      schema: "core",
      merge: false,
      uniqueKeys: true,
    });
    checkCpu();
    if (document.errors.length > 0) {
      return { ok: false, code: "parse_failed" };
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown;
    } catch {
      // With a parsed document, toJS failures are bounded expansion failures.
      throw new BoundedYamlError("alias_count");
    }
    checkCpu();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, code: "root_type" };
    }

    let nodes = 0;
    let bytes = 0;
    const active = new WeakSet<object>();
    const addBytes = (valueText: string) => {
      bytes += encoder.encode(valueText).byteLength;
      if (bytes > MAX_EXPANDED_SPEC_BYTES) {
        throw new BoundedYamlError("expanded_size");
      }
    };
    const visit = (item: unknown, depth: number): void => {
      nodes += 1;
      if ((nodes & 127) === 0) checkCpu();
      if (nodes > MAX_EXPANDED_NODES) {
        throw new BoundedYamlError("node_count");
      }
      if (depth > MAX_EXPANDED_DEPTH) throw new BoundedYamlError("depth");
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
          throw new BoundedYamlError("unsupported_value");
        }
        addBytes(String(item));
        return;
      }
      if (typeof item !== "object") {
        throw new BoundedYamlError("unsupported_value");
      }
      if (active.has(item)) throw new BoundedYamlError("alias_count");
      const prototype = Object.getPrototypeOf(item);
      if (
        !Array.isArray(item) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        throw new BoundedYamlError("unsupported_value");
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
    checkCpu();
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (encoder.encode(json).byteLength > MAX_EXPANDED_SPEC_BYTES) {
      return { ok: false, code: "expanded_size" };
    }
    return { ok: true, json };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof BoundedYamlError ? error.code : "parse_failed",
    };
  }
}
