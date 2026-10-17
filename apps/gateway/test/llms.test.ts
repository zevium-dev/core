import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, { __setTestPipelineDeps, type Env } from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureSpecSource } from "../src/spec-source";

const ORIGIN = "https://gateway.test";
const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
  servers: [{ url: "https://upstream.test/v1" }],
  paths: {
    "/example": {
      get: {
        "x-zevium-cost": 3,
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", example: { greeting: "hi" } },
              },
            },
          },
        },
      },
    },
  },
});

function installFixtures() {
  const specs = new FixtureSpecSource();
  specs.set("acme", "demo", {
    specVersionId: "version_demo",
    version: "1.0.0",
    spec: SPEC,
    projectId: "proj_demo",
    organizationId: "org_llms",
    clerkOrgId: "org_llms",
    visibility: "public",
  });
  __setTestPipelineDeps({
    keyVerifier: new FixtureKeyVerifier({}),
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(url, init),
    { ...env, APP_ORIGIN: "https://web.example.test" } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  __setTestPipelineDeps(null);
});

describe("gateway /llms.txt", () => {
  it("serves the shared guide with this gateway and the paired web origin", async () => {
    const response = await call(`${ORIGIN}/llms.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    const text = await response.text();
    expect(text).toContain(
      `claude mcp add --transport http zevium '${ORIGIN}/mcp'`,
    );
    expect(text).toContain(`url = "${ORIGIN}/mcp"`);
    expect(text).toContain("https://web.example.test/app/settings/keys");
    expect(text).toContain("https://web.example.test/cli/zevium.mjs");

    const head = await call(`${ORIGIN}/llms.txt`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await call(`${ORIGIN}/llms.txt`, { method: "POST" })).status).toBe(
      405,
    );
  });

  it("every gateway URL it advertises reaches its real handler", async () => {
    installFixtures();
    const text = await (await call(`${ORIGIN}/llms.txt`)).text();
    const urls = new Set(
      Array.from(text.matchAll(/https?:\/\/[^\s)'"]+/g), (match) =>
        decodeURIComponent(match[0]),
      ).filter((url) => url.startsWith(ORIGIN)),
    );
    expect(urls).toEqual(
      new Set([
        `${ORIGIN}/mcp`,
        `${ORIGIN}/discovery`,
        `${ORIGIN}/docs/{publisherHandle}/{projectSlug}`,
        `${ORIGIN}/gateway/{publisherHandle}/{projectSlug}/{path}`,
        `${ORIGIN}/mock/{publisherHandle}/{projectSlug}/{path}`,
      ]),
    );
    const resolve = (url: string) =>
      url
        .replace("{publisherHandle}", "acme")
        .replace("{projectSlug}", "demo")
        .replace("{path}", "example");

    const mcp = await call(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(200);
    const tools = (
      (await mcp.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
    for (const tool of tools) expect(text).toContain(`${tool}(`);
    expect(tools.sort()).toEqual([
      "call_api_read",
      "call_api_write",
      "get_api_docs",
      "search_apis",
    ]);
    expect(text).not.toMatch(/\bcall_api\b/);
    // Keyless OAuth MCP sessions return these 402 reasons from call_api_*.
    expect(text).toContain("oauth_missing_api_key");
    expect(text).toContain("oauth_key_provisioning");

    expect((await call(`${ORIGIN}/discovery`)).status).toBe(200);

    const docs = await call(
      resolve(`${ORIGIN}/docs/{publisherHandle}/{projectSlug}`),
    );
    expect(docs.status).toBe(200);

    const mock = await call(
      resolve(`${ORIGIN}/mock/{publisherHandle}/{projectSlug}/{path}`),
    );
    expect(mock.status).toBe(200);
    expect(mock.headers.get("x-zevium-mock")).toBe("1");
    expect(text).toContain("x-zevium-mock: 1");

    // Default deps run the real metered pipeline, which rejects before upstream.
    __setTestPipelineDeps(null);
    const paid = await call(
      resolve(`${ORIGIN}/gateway/{publisherHandle}/{projectSlug}/{path}`),
    );
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as {
      error: string;
      reason: string;
      actions: Record<string, string>;
    };
    expect(body.error).toBe("payment_required");
    expect(text).toContain(body.reason);
    for (const action of Object.keys(body.actions))
      expect(text).toContain(`actions.${action}`);
    for (const href of Object.values(body.actions))
      expect(text).toContain(href);
  });
});
