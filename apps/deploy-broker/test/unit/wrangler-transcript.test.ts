import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorizeApiRoute } from "../../src/api-policy";
import { buildManifest } from "../../src/manifest";
import { HEAD_SHA, PRODUCTION_SHA, TEST_MODULE_ARTIFACTS } from "../fixtures";

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
    sourceRunId: "8999",
  });
}

describe("Wrangler 4.119.0 observed transcript", () => {
  it.each([
    ["gateway upload", "wrangler-4.119.0-gateway.json", 7],
    ["gateway version deployment", "wrangler-4.119.0-gateway-deploy.json", 5],
  ])(
    "keeps every observed %s request inside broker allowlist",
    async (_label, file, count) => {
      const source = await readFile(
        new URL(`../../transcripts/${file}`, import.meta.url),
        "utf8",
      );
      const entries = JSON.parse(source) as TranscriptEntry[];
      expect(entries).toHaveLength(count);
      for (const entry of entries) {
        const url = new URL(`https://api.cloudflare.com${entry.path}`);
        expect(() =>
          authorizeApiRoute(
            productionGateway(),
            entry.method,
            url.pathname.replace("/client/v4", ""),
            url.search,
          ),
        ).not.toThrow();
      }
    },
  );
});
