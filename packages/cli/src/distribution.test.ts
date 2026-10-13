import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { generateSpecContract } from "@zevium/shared";
import { representativeSpec } from "../../shared/src/spec-generation/fixture.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const scratchRoot = resolve(packageRoot, ".tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(resolve(scratchRoot, "distribution-"));
const bundle = resolve(scratch, "zevium.mjs");
const buildOutput = resolve(scratch, "build/zevium.mjs");
execFileSync(process.execPath, [
  resolve(packageRoot, "scripts/build.mjs"),
  buildOutput,
]);
copyFileSync(buildOutput, bundle);
rmSync(resolve(scratch, "build"), { recursive: true });
const loader = resolve(scratch, "isolate.mjs");
writeFileSync(
  loader,
  `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url !== ${JSON.stringify(pathToFileURL(bundle).href)} && !result.url.startsWith("node:")) {
      throw new Error("External module resolution forbidden: " + specifier);
    }
    return result;
  }
});
if (process.env.TEST_NODE_VERSION) {
  Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });
}
`,
);
const env = { PATH: process.env.PATH, NODE_PATH: "", NODE_OPTIONS: "" };
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("single-file CLI distribution", () => {
  it("runs help with only the bundle and Node builtins resolvable", () => {
    expect(readFileSync(bundle, "utf8").split("\n")[0]).toBe(
      "#!/usr/bin/env node",
    );
    expect(statSync(bundle).mode & 0o111).toBe(0o111);
    const output = execFileSync(
      process.execPath,
      ["--import", loader, bundle, "--help"],
      {
        cwd: scratch,
        env,
        encoding: "utf8",
      },
    );
    expect(output).toContain("Usage: zevium <publisher> <project>");
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bin.zevium).toBe("./dist/zevium.mjs");
  });

  it("contains no builder paths or dependency path comments", () => {
    const source = readFileSync(bundle, "utf8");
    expect(source).not.toContain(".local/share/pnpm");
    expect(source).not.toContain("node_modules/");
    expect(source).not.toMatch(/\/(?:home|Users)\//);
  });

  it("loads sanitized docs and calls a local gateway from the isolated bundle", async () => {
    const payload = "before\u001b[2J\u202ereversed\u202cafter";
    const sanitized = "before\\u001b[2J\\u202ereversed\\u202cafter";
    const generated = generateSpecContract({
      spec: JSON.stringify(representativeSpec),
      version: "2.0.0",
    });
    generated.markdown = payload;
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body) as unknown,
      });
      const text =
        requests.length < 3
          ? JSON.stringify({ publisherData: { generated } })
          : payload;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text }] },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
      const gatewayEnv = {
        ...env,
        ZEVIUM_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
      };
      const runBundle = promisify(execFile);
      const docs = await runBundle(
        process.execPath,
        ["--import", loader, bundle, "acme", "pets"],
        { cwd: scratch, env: gatewayEnv },
      );
      expect(docs.stdout).toBe(`${sanitized}\n`);
      expect(docs.stderr).toBe("");
      const call = await runBundle(
        process.execPath,
        [
          "--import",
          loader,
          bundle,
          "acme",
          "pets",
          "getpet_1",
          "--path-id",
          "pet-123",
        ],
        { cwd: scratch, env: { ...gatewayEnv, ZEVIUM_API_KEY: "zev_fixture" } },
      );
      expect(call.stdout).toBe(`${sanitized}\n`);
      expect(call.stderr).toBe("");
      expect(requests).toEqual([
        {
          url: "/mcp",
          authorization: undefined,
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_api_docs",
              arguments: { org: "acme", project: "pets" },
            },
          },
        },
        {
          url: "/mcp",
          authorization: "Bearer zev_fixture",
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_api_docs",
              arguments: { org: "acme", project: "pets" },
            },
          },
        },
        {
          url: "/mcp",
          authorization: "Bearer zev_fixture",
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_api",
              arguments: {
                org: "acme",
                project: "pets",
                method: "GET",
                path: "/pets/{id}",
                pathParams: { id: "pet-123" },
              },
            },
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("runs as an executable renamed to zevium", () => {
    writeFileSync(resolve(scratch, "package.json"), '{"type":"commonjs"}');
    const executable = resolve(scratch, "zevium");
    copyFileSync(bundle, executable);
    expect(
      execFileSync(executable, ["--help"], {
        cwd: scratch,
        env,
        encoding: "utf8",
      }),
    ).toContain("Usage: zevium");
  });

  it.each(["18.20.0", "20.19.0", "22.11.9"])(
    "rejects Node %s before starting",
    (version) => {
      const result = spawnSync(
        process.execPath,
        ["--import", loader, bundle, "--help"],
        {
          cwd: scratch,
          env: { ...env, TEST_NODE_VERSION: version },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `zevium: Node.js 22.12.0 or newer is required; found ${version}.\n`,
      );
    },
  );

  it.each(["22.12.0", "22.12.1", "22.20.0", "24.15.0", "25.0.0"])(
    "accepts Node %s",
    (version) => {
      expect(
        execFileSync(process.execPath, ["--import", loader, bundle, "--help"], {
          cwd: scratch,
          env: { ...env, TEST_NODE_VERSION: version },
          encoding: "utf8",
        }),
      ).toContain("Usage: zevium");
    },
  );
});
