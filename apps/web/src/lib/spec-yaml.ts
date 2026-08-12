import {
  MAX_YAML_ALIASES,
  MAX_YAML_INPUT_BYTES,
  MAX_YAML_LINES,
  YAML_ERROR_MESSAGES,
  YAML_WORKER_TIMEOUT_MS,
  type YamlFailureCode,
} from "./spec-yaml-limits";
import type { YamlWorkerResult } from "./spec-yaml.worker-core";

export {
  MAX_EXPANDED_SPEC_BYTES,
  MAX_YAML_ALIASES,
  MAX_YAML_INPUT_BYTES,
  MAX_YAML_LINES,
} from "./spec-yaml-limits";

export type YamlConvertResult =
  | { ok: true; json: string; convertedFromYaml: boolean }
  | { ok: false; error: string; code: YamlFailureCode };

type WorkerPort = Pick<
  Worker,
  "addEventListener" | "removeEventListener" | "postMessage" | "terminate"
>;

export type YamlWorkerOptions = {
  createWorker?: () => WorkerPort;
  timeoutMs?: number;
};

const encoder = new TextEncoder();

function preflightYaml(text: string): YamlFailureCode | null {
  if (encoder.encode(text).byteLength > MAX_YAML_INPUT_BYTES) {
    return "input_size";
  }
  let lines = 1;
  let indicators = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines > MAX_YAML_LINES) {
      return "line_count";
    }
    const char = text[index];
    if ((char === "*" || char === "&") && index > 0) {
      const previous = text[index - 1]!;
      if (/\s|[,[{]/.test(previous)) indicators += 1;
      if (indicators > MAX_YAML_ALIASES * 2) return "alias_count";
    }
  }
  return null;
}

function failure(code: YamlFailureCode): YamlConvertResult {
  return { ok: false, code, error: YAML_ERROR_MESSAGES[code] };
}

function defaultWorker(): WorkerPort {
  return new Worker(new URL("./spec-yaml.worker.ts", import.meta.url), {
    type: "module",
    name: "zevium-yaml-parser",
  });
}

async function parseInKillableWorker(
  text: string,
  options: YamlWorkerOptions,
): Promise<YamlWorkerResult> {
  let worker: WorkerPort;
  try {
    worker = (options.createWorker ?? defaultWorker)();
  } catch {
    return { ok: false, code: "parse_failed" };
  }
  return await new Promise<YamlWorkerResult>((resolve) => {
    let settled = false;
    const finish = (result: YamlWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.terminate();
      resolve(result);
    };
    const onMessage = (event: MessageEvent<YamlWorkerResult>) => {
      const result = event.data;
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.ok !== "boolean"
      ) {
        finish({ ok: false, code: "parse_failed" });
        return;
      }
      finish(result);
    };
    const onError = () => finish({ ok: false, code: "parse_failed" });
    const timeout = setTimeout(
      () => finish({ ok: false, code: "cpu_limit" }),
      options.timeoutMs ?? YAML_WORKER_TIMEOUT_MS,
    );
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ text });
  });
}

/** JSON stays local; every YAML parse runs in a hard-terminated worker. */
export async function convertSpecInputToJson(
  text: string,
  options: YamlWorkerOptions = {},
): Promise<YamlConvertResult> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, json: "", convertedFromYaml: false };
  }
  try {
    JSON.parse(trimmed);
    return { ok: true, json: text, convertedFromYaml: false };
  } catch {
    // YAML path stays isolated below.
  }
  const preflight = preflightYaml(trimmed);
  if (preflight !== null) return failure(preflight);
  const result = await parseInKillableWorker(trimmed, options);
  return result.ok
    ? { ok: true, json: result.json, convertedFromYaml: true }
    : failure(result.code);
}

export function looksLikeYaml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && !trimmed.startsWith("{") && !trimmed.startsWith("[");
}
