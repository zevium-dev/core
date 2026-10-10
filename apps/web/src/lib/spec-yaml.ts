import {
  MAX_YAML_INPUT_BYTES,
  MAX_YAML_LINES,
  YAML_ERROR_MESSAGES,
  YAML_WORKER_TIMEOUT_MS,
  type YamlFailureCode,
} from "./spec-yaml-limits";
import type { YamlWorkerResult } from "./spec-yaml.worker-core";

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
  startupTimeoutMs?: number;
};

const encoder = new TextEncoder();

function preflightYaml(text: string): YamlFailureCode | null {
  if (encoder.encode(text).byteLength > MAX_YAML_INPUT_BYTES) {
    return "input_size";
  }
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines > MAX_YAML_LINES) {
      return "line_count";
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
    let ready = false;
    const onMessage = (
      event: MessageEvent<YamlWorkerResult | { ready: true }>,
    ) => {
      const result = event.data;
      if (
        result !== null &&
        typeof result === "object" &&
        "ready" in result &&
        result.ready === true &&
        !ready
      ) {
        ready = true;
        clearTimeout(timeout);
        timeout = setTimeout(
          () => finish({ ok: false, code: "cpu_limit" }),
          options.timeoutMs ?? YAML_WORKER_TIMEOUT_MS,
        );
        worker.postMessage({ text });
        return;
      }
      if (
        result === null ||
        typeof result !== "object" ||
        !("ok" in result) ||
        typeof result.ok !== "boolean"
      ) {
        finish({ ok: false, code: "parse_failed" });
        return;
      }
      finish(result);
    };
    const onError = () => finish({ ok: false, code: "parse_failed" });
    let timeout = setTimeout(
      () => finish({ ok: false, code: "cpu_limit" }),
      options.startupTimeoutMs ?? 10_000,
    );
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
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
