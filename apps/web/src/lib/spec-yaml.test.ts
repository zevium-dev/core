import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_YAML_ALIASES,
  MAX_YAML_INPUT_BYTES,
  MAX_YAML_LINES,
} from "./spec-yaml-limits";
import { convertSpecInputToJson } from "./spec-yaml";
import { parseYamlInWorker } from "./spec-yaml.worker-core";

// Parser shape/expansion tests use a deterministic CPU clock. Actual worker
// deadline tests below retain real timers and prove hard termination.
beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function inlineWorker(startupMs = 0, silent = false): Worker {
  const messageListeners = new Set<(event: MessageEvent) => void>();
  const errorListeners = new Set<() => void>();
  return {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) {
      const callback =
        typeof listener === "function"
          ? listener
          : (event: Event) => listener.handleEvent(event);
      if (type === "message") {
        messageListeners.add((event) => callback(event));
        setTimeout(
          () =>
            callback(new MessageEvent("message", { data: { ready: true } })),
          startupMs,
        );
      } else if (type === "error") {
        errorListeners.add(() => callback(new Event("error")));
      }
    },
    removeEventListener() {},
    postMessage(value: unknown) {
      if (silent) return;
      queueMicrotask(() => {
        const text =
          value !== null &&
          typeof value === "object" &&
          "text" in value &&
          typeof value.text === "string"
            ? value.text
            : "";
        const event = new MessageEvent("message", {
          data: parseYamlInWorker(text),
        });
        for (const listener of messageListeners) listener(event);
      });
    },
    terminate() {},
  } as unknown as Worker;
}

const workerOptions = { createWorker: () => inlineWorker() };

describe("convertSpecInputToJson", () => {
  it("keeps valid JSON text", async () => {
    const raw = '{\n  "openapi": "3.1.0"\n}';
    const result = await convertSpecInputToJson(raw, workerOptions);
    expect(result).toEqual({
      ok: true,
      json: raw,
      convertedFromYaml: false,
    });
  });

  it("converts YAML to pretty JSON", async () => {
    const yaml = `openapi: "3.1.0"
info:
  title: Demo
  version: "1.0.0"
servers:
  - url: https://api.example.com
paths: {}
`;
    const result = await convertSpecInputToJson(yaml, workerOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.convertedFromYaml).toBe(true);
    const parsed = JSON.parse(result.json) as {
      openapi: string;
      info: { title: string };
    };
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.info.title).toBe("Demo");
  });

  it("errors on garbage without parser excerpts", async () => {
    const source = ":\n  - private-secret: [";
    const result = await convertSpecInputToJson(source, workerOptions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Could not parse/);
    expect(result.error).not.toContain("private-secret");
  });

  it("allows empty", async () => {
    expect(await convertSpecInputToJson("", workerOptions)).toEqual({
      ok: true,
      json: "",
      convertedFromYaml: false,
    });
  });

  it("rejects alias bombs before post-expansion serialization", async () => {
    const aliases = Array.from(
      { length: MAX_YAML_ALIASES + 1 },
      (_, index) => `  item${index}: *seed`,
    ).join("\n");
    const result = await convertSpecInputToJson(
      `seed: &seed
  value: ${"x".repeat(1_000)}
expanded:
${aliases}`,
      workerOptions,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/alias|complexity/i);
  });

  it("rejects exponential expansion even below alias-count ceiling", async () => {
    const result = await convertSpecInputToJson(
      `a: &a [x, x, x, x, x, x, x, x, x, x]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]`,
      workerOptions,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/alias|complexity|size/i);
  });

  it("rejects post-expansion output beyond transport cap", async () => {
    const chunk = "x".repeat(220_000);
    const aliases = Array.from({ length: 4 }, () => "  - *seed").join("\n");
    const result = await convertSpecInputToJson(
      `seed: &seed ${chunk}
expanded:
${aliases}`,
      workerOptions,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/size/i);
  });

  it("hard-terminates a non-yielding parser worker", async () => {
    let terminated = false;
    const silent = {
      addEventListener() {},
      removeEventListener() {},
      postMessage() {},
      terminate() {
        terminated = true;
      },
    } as unknown as Worker;
    const result = await convertSpecInputToJson("openapi: 3.1.0", {
      createWorker: () => silent,
      timeoutMs: 1,
      startupTimeoutMs: 1,
    });
    expect(result).toMatchObject({ ok: false, code: "cpu_limit" });
    expect(terminated).toBe(true);
  });

  it("rejects byte and line bombs before allocating a parser worker", async () => {
    let workers = 0;
    const createWorker = () => {
      workers += 1;
      return inlineWorker();
    };
    await expect(
      convertSpecInputToJson(`value: ${"x".repeat(MAX_YAML_INPUT_BYTES)}`, {
        createWorker,
      }),
    ).resolves.toMatchObject({ ok: false, code: "input_size" });
    await expect(
      convertSpecInputToJson(
        Array.from({ length: MAX_YAML_LINES + 1 }, () => "x:").join("\n"),
        { createWorker },
      ),
    ).resolves.toMatchObject({ ok: false, code: "line_count" });
    expect(workers).toBe(0);
  });

  it("rejects expanded node and depth bombs with stable codes", async () => {
    const nodeBomb = `value: [${Array.from({ length: 20_001 }, () => "0").join(",")}]`;
    const nodes = await convertSpecInputToJson(nodeBomb, workerOptions);
    expect(nodes).toMatchObject({ ok: false });
    if (!nodes.ok) expect(["node_count", "cpu_limit"]).toContain(nodes.code);

    const depthBomb = `value: ${"[".repeat(45)}0${"]".repeat(45)}`;
    await expect(
      convertSpecInputToJson(depthBomb, workerOptions),
    ).resolves.toMatchObject({ ok: false, code: "depth" });
  });

  it("never returns parser excerpts or source PII", async () => {
    const pii = "alice@example.com";
    const result = await convertSpecInputToJson(
      `openapi: [${pii}\nprivate-token: [`,
      workerOptions,
    );
    expect(result).toMatchObject({ ok: false, code: "parse_failed" });
    expect(JSON.stringify(result)).not.toContain(pii);
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});

it("accepts markdown bullets, anchors, and alias-like text inside a YAML block scalar", async () => {
  const result = await convertSpecInputToJson(
    `openapi: 3.1.0\ninfo:\n  description: |\n${Array.from({ length: 50 }, () => "    * use *markdown* & plain text").join("\n")}`,
    workerOptions,
  );
  expect(result.ok).toBe(true);
});
it("gives a cold worker a separate startup budget", async () => {
  const result = await convertSpecInputToJson("openapi: 3.1.0", {
    createWorker: () => inlineWorker(30),
    timeoutMs: 10,
    startupTimeoutMs: 1000,
  });
  expect(result.ok).toBe(true);
});
it("terminates a ready worker that stops responding", async () => {
  const worker = inlineWorker(0, true);
  const terminate = vi.spyOn(worker, "terminate");
  const result = await convertSpecInputToJson("openapi: 3.1.0", {
    createWorker: () => worker,
    timeoutMs: 5,
  });
  expect(result).toMatchObject({ ok: false, code: "cpu_limit" });
  expect(terminate).toHaveBeenCalledOnce();
});
