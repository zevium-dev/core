import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorizeApiRoute } from "../../src/api-policy";
import { buildManifest } from "../../src/manifest";
import {
  HEAD_SHA,
  PREVIEW_SECRET_DIGESTS,
  PRODUCTION_SHA,
  TEST_MODULE_ARTIFACTS,
} from "../fixtures";

interface TranscriptEntry {
  method: string;
  path: string;
}

function productionGateway() {
  return buildManifest({
    ...TEST_MODULE_ARTIFACTS,
    eventName: "workflow_run",
    headSha: HEAD_SHA,
    oidcSha: PRODUCTION_SHA,
    profile: "production-gateway",
    ref: "refs/heads/develop",
    runAttempt: 1,
    runId: "9002",
    secretDigests: PREVIEW_SECRET_DIGESTS,
    sourceRunId: "8999",
  });
}

describe("Wrangler 4.119.0 observed transcript", () => {
  it("rejects Wrangler upload except exact lifecycle read", async () => {
    const source = await readFile(
      new URL(
        "../../transcripts/wrangler-4.119.0-gateway.json",
        import.meta.url,
      ),
      "utf8",
    );
    const entries = JSON.parse(source) as TranscriptEntry[];
    expect(entries).toHaveLength(7);
    for (const [index, entry] of entries.entries()) {
      const url = new URL(`https://api.cloudflare.com${entry.path}`);
      const authorization = () =>
        authorizeApiRoute(
          productionGateway(),
          entry.method,
          url.pathname.replace("/client/v4", ""),
          url.search,
        );
      if (index === 0) expect(authorization).not.toThrow();
      else expect(authorization).toThrow();
    }
  });

  it("rejects Wrangler tag-resolution reads removed by sealed-ID protocol", async () => {
    const source = await readFile(
      new URL(
        "../../transcripts/wrangler-4.119.0-gateway-deploy.json",
        import.meta.url,
      ),
      "utf8",
    );
    const entries = JSON.parse(source) as TranscriptEntry[];
    expect(entries).toHaveLength(5);
    for (const [index, entry] of entries.entries()) {
      const url = new URL(`https://api.cloudflare.com${entry.path}`);
      const authorization = () =>
        authorizeApiRoute(
          productionGateway(),
          entry.method,
          url.pathname.replace("/client/v4", ""),
          url.search,
        );
      if (index === 0 || index === 3 || index === 4)
        expect(authorization).not.toThrow();
      else expect(authorization).toThrow();
    }
  });

  it("pins evidence that Wrangler 4.119.0 forces secret inheritance", async () => {
    const [packageSource, cliSource] = await Promise.all([
      readFile(
        new URL("../../node_modules/wrangler/package.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../../node_modules/wrangler/wrangler-dist/cli.js",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(JSON.parse(packageSource)).toMatchObject({ version: "4.119.0" });
    expect(cliSource).toContain("keepSecrets: true");
    expect(cliSource).toContain(
      'keep_bindings.push("secret_text", "secret_key")',
    );
  });
});
