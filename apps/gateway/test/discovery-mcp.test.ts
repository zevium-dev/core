import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  __setTestPipelineDeps,
  __setTestUsageMutation,
  type Env,
} from "../src/index";
import {
  FixtureCatalogueSource,
  type CatalogueListArgs,
  type CatalogueListing,
  type CataloguePage,
  type CatalogueSource,
} from "../src/catalogue-source";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureSpecSource } from "../src/spec-source";
import { CollectingUsageSink } from "../src/usage";
import type { WalletDO } from "../src/wallet";

type WalletStub = DurableObjectStub<WalletDO>;

const ORG_SLUG = "acme";
const PROJECT_SLUG = "demo";
const KEY_SECRET = "zev_test_secret_mcp_1";
const KEY_ID = "ak_mcp_1";
const CLERK_ORG = "org_clerk_mcp";
const CONVEX_ORG = "org_convex_mcp";

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Demo Weather", version: "1.0.0" },
  servers: [{ url: "https://upstream.test/v1" }],
  paths: {
    "/echo": {
      post: {
        summary: "Echo body",
        "x-zevium-cost": 3,
      },
    },
    "/forecast": {
      get: {
        summary: "Get forecast",
        "x-zevium-cost": 2,
        "x-zevium-free-tier": 5,
      },
    },
  },
});

const LISTING: CatalogueListing = {
  name: "Demo Weather",
  slug: PROJECT_SLUG,
  description: "Weather forecasts for agents",
  tags: ["weather", "demo"],
  orgName: "Acme Corp",
  publisherHandle: ORG_SLUG,
  publishedAt: 1_700_000_000_000,
};

class TwoPageCatalogueSource implements CatalogueSource {
  constructor(
    readonly first: CatalogueListing,
    readonly second: CatalogueListing,
  ) {}

  async listPublic(args?: CatalogueListArgs): Promise<CataloguePage> {
    if (args?.cursor === "page-2") {
      return { items: [this.second], nextCursor: null };
    }
    return { items: [this.first], nextCursor: "page-2" };
  }
}

function walletStub(clerkOrgId: string): WalletStub {
  const id = env.WALLET.idFromName(clerkOrgId);
  return env.WALLET.get(id);
}

function makeFetchMock(
  handler: (req: Request) => Promise<Response> | Response,
) {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    calls.push(req);
    return handler(req);
  };
  return { fetchImpl, calls };
}

async function installAgentFixtures(opts: {
  clerkOrgId: string;
  fetchImpl?: typeof fetch;
  credits?: number;
  listings?: CatalogueListing[];
  catalogueSource?: CatalogueSource;
}) {
  const usage = new CollectingUsageSink();
  const keys = new FixtureKeyVerifier({
    [KEY_SECRET]: {
      orgId: opts.clerkOrgId,
      keyId: KEY_ID,
      scopes: ["read"],
    },
  });
  const specs = new FixtureSpecSource();
  specs.set(ORG_SLUG, PROJECT_SLUG, {
    spec: SPEC,
    projectId: "proj_demo",
    organizationId: CONVEX_ORG,
    clerkOrgId: opts.clerkOrgId,
    visibility: "private",
  });
  const catalogue =
    opts.catalogueSource ??
    new FixtureCatalogueSource(opts.listings ?? [LISTING]);

  __setTestPipelineDeps({
    keyVerifier: keys,
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: catalogue,
    usageSink: usage,
    fetchImpl:
      opts.fetchImpl ?? (async () => new Response("ok", { status: 200 })),
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });

  if (opts.credits && opts.credits > 0) {
    await walletStub(opts.clerkOrgId).grant(
      `grant_${crypto.randomUUID()}`,
      opts.credits,
    );
  }

  return { usage, keys, specs, catalogue };
}

async function workerFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const request = new Request(`https://gateway.test${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function mcpCall(
  method: string,
  params?: unknown,
  init: RequestInit = {},
): Promise<unknown> {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method,
  };
  if (params !== undefined) body.params = params;

  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await workerFetch("/mcp", {
    method: "POST",
    ...init,
    headers,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolText(rpc: unknown): string {
  if (!isRecord(rpc) || !("result" in rpc)) {
    throw new Error("missing result");
  }
  const result = rpc.result;
  if (
    !isRecord(result) ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("missing content");
  }
  const first = result.content[0];
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error("missing text content");
  }
  return first.text;
}

afterEach(() => {
  __setTestPipelineDeps(null);
  __setTestUsageMutation(null);
});

describe("GET /discovery", () => {
  it("returns published APIs with per-endpoint pricing", async () => {
    await installAgentFixtures({ clerkOrgId: "org_disc_shape" });

    const res = await workerFetch("/discovery");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toMatch(/max-age=60/);

    const body: unknown = await res.json();
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) return;

    expect(Array.isArray(body.apis)).toBe(true);
    if (!Array.isArray(body.apis)) return;
    expect(body.apis).toHaveLength(1);

    const api = body.apis[0];
    expect(isRecord(api)).toBe(true);
    if (!isRecord(api)) return;

    expect(api.name).toBe("Demo Weather");
    expect(api.publisherHandle).toBe(ORG_SLUG);
    expect(api.slug).toBe(PROJECT_SLUG);
    expect(api.description).toBe("Weather forecasts for agents");
    expect(api.gatewayBaseUrl).toBe(
      `https://gateway.test/gateway/${ORG_SLUG}/${PROJECT_SLUG}`,
    );

    expect(Array.isArray(api.endpoints)).toBe(true);
    if (!Array.isArray(api.endpoints)) return;

    const byKey = new Map<string, Record<string, unknown>>();
    for (const ep of api.endpoints) {
      if (!isRecord(ep)) continue;
      byKey.set(`${String(ep.method)} ${String(ep.path)}`, ep);
    }

    const echo = byKey.get("POST /echo");
    expect(echo).toBeTruthy();
    expect(echo!.credits).toBe(3);
    expect(echo!.summary).toBe("Echo body");

    const forecast = byKey.get("GET /forecast");
    expect(forecast).toBeTruthy();
    expect(forecast!.credits).toBe(2);
    expect(forecast!.freeTier).toBe(5);
    expect(forecast!.summary).toBe("Get forecast");
  });

  it("returns empty apis when catalogue empty", async () => {
    await installAgentFixtures({
      clerkOrgId: "org_disc_empty",
      listings: [],
    });
    const res = await workerFetch("/discovery");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(
      isRecord(body) && Array.isArray(body.apis) && body.apis.length === 0,
    ).toBe(true);
  });

  it("returns APIs from every catalogue page", async () => {
    const second = {
      ...LISTING,
      name: "Second API",
      slug: "second",
    };
    await installAgentFixtures({
      clerkOrgId: "org_disc_pages",
      catalogueSource: new TwoPageCatalogueSource(LISTING, second),
    });

    const res = await workerFetch("/discovery");
    const body: unknown = await res.json();
    expect(isRecord(body) && Array.isArray(body.apis)).toBe(true);
    if (!isRecord(body) || !Array.isArray(body.apis)) return;
    expect(body.apis.map((api) => isRecord(api) && api.slug)).toEqual([
      PROJECT_SLUG,
      "second",
    ]);
  });
});

describe("MCP /mcp", () => {
  it("rejects request bodies larger than 1 MiB", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_request_limit" });
    const res = await workerFetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        padding: "x".repeat(1024 * 1024),
      }),
    });

    expect(res.status).toBe(413);
    const body: unknown = await res.json();
    expect(
      isRecord(body) &&
        isRecord(body.error) &&
        body.error.message === "Request body exceeds 1 MiB limit",
    ).toBe(true);
  });

  it("rejects JSON-RPC batches larger than 100 requests", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_batch_limit" });
    const batch = Array.from({ length: 101 }, (_, id) => ({
      jsonrpc: "2.0",
      id,
      method: "ping",
    }));
    const res = await workerFetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(
      isRecord(body) &&
        isRecord(body.error) &&
        body.error.message === "Invalid Request: batch limit is 100",
    ).toBe(true);
  });

  it("GET lists server tools", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_get" });
    const res = await workerFetch("/mcp");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isRecord(body)).toBe(true);
    if (!isRecord(body)) return;
    expect(body.name).toBe("zevium-gateway");
    expect(Array.isArray(body.tools)).toBe(true);
    if (!Array.isArray(body.tools)) return;
    expect(body.tools).toEqual(
      expect.arrayContaining(["search_apis", "get_api_docs", "call_api"]),
    );
  });

  it("tools/list returns three tools", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_list" });
    const rpc: unknown = await mcpCall("tools/list");
    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    expect(rpc.jsonrpc).toBe("2.0");
    expect(rpc.id).toBe(1);

    const result = rpc.result;
    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) return;
    expect(Array.isArray(result.tools)).toBe(true);
    if (!Array.isArray(result.tools)) return;

    const names = result.tools
      .map((t) => (isRecord(t) && typeof t.name === "string" ? t.name : null))
      .filter((n): n is string => n !== null);
    expect(names).toEqual(
      expect.arrayContaining(["search_apis", "get_api_docs", "call_api"]),
    );
    expect(names).toHaveLength(3);
  });

  it("initialize returns protocol + capabilities", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_init" });
    const rpc: unknown = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    const result = rpc.result;
    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) return;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(isRecord(result.serverInfo) && result.serverInfo.name).toBe(
      "zevium-gateway",
    );
  });

  it("search_apis returns catalogue matches with pricing", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_search" });
    const rpc: unknown = await mcpCall("tools/call", {
      name: "search_apis",
      arguments: { query: "weather" },
    });
    const text = toolText(rpc);
    const parsed: unknown = JSON.parse(text);
    expect(isRecord(parsed) && Array.isArray(parsed.matches)).toBe(true);
    if (!isRecord(parsed) || !Array.isArray(parsed.matches)) return;
    expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
    const first = parsed.matches[0];
    expect(isRecord(first)).toBe(true);
    if (!isRecord(first)) return;
    expect(first.slug).toBe(PROJECT_SLUG);
    expect(first.publisherHandle).toBe(ORG_SLUG);
    expect(Array.isArray(first.endpoints)).toBe(true);
  });

  it("search_apis returns matches from every catalogue page", async () => {
    const second = {
      ...LISTING,
      name: "Second API",
      slug: "second",
    };
    await installAgentFixtures({
      clerkOrgId: "org_mcp_search_pages",
      catalogueSource: new TwoPageCatalogueSource(LISTING, second),
    });

    const rpc: unknown = await mcpCall("tools/call", {
      name: "search_apis",
      arguments: { query: "" },
    });
    const parsed: unknown = JSON.parse(toolText(rpc));
    expect(isRecord(parsed) && Array.isArray(parsed.matches)).toBe(true);
    if (!isRecord(parsed) || !Array.isArray(parsed.matches)) return;
    expect(parsed.matches.map((api) => isRecord(api) && api.slug)).toEqual([
      PROJECT_SLUG,
      "second",
    ]);
  });

  it("get_api_docs returns endpoints + usage notes", async () => {
    await installAgentFixtures({ clerkOrgId: "org_mcp_docs" });
    const rpc: unknown = await mcpCall("tools/call", {
      name: "get_api_docs",
      arguments: { org: ORG_SLUG, project: PROJECT_SLUG },
    });
    const text = toolText(rpc);
    const parsed: unknown = JSON.parse(text);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) return;
    expect(parsed.org).toBe(ORG_SLUG);
    expect(parsed.project).toBe(PROJECT_SLUG);
    expect(Array.isArray(parsed.endpoints)).toBe(true);
    expect(Array.isArray(parsed.usageNotes)).toBe(true);
    if (!Array.isArray(parsed.endpoints)) return;
    expect(parsed.endpoints.length).toBe(2);
  });

  it("call_api routes through metered pipeline (wallet reserve)", async () => {
    const clerkOrgId = "org_mcp_call_metered";
    const { fetchImpl, calls } = makeFetchMock(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/echo");
      const body = await req.text();
      return new Response(`echo:${body}`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    await installAgentFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 100,
    });

    const before = await walletStub(clerkOrgId).getState();
    expect(before.balance).toBe(100);
    expect(before.pendingSettlements).toHaveLength(0);

    const rpc: unknown = await mcpCall(
      "tools/call",
      {
        name: "call_api",
        arguments: {
          org: ORG_SLUG,
          project: PROJECT_SLUG,
          method: "POST",
          path: "/echo",
          body: "hello-mcp",
        },
      },
      { headers: { authorization: `Bearer ${KEY_SECRET}` } },
    );

    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    const result = rpc.result;
    expect(isRecord(result)).toBe(true);
    if (!isRecord(result)) return;
    // Success path must NOT be marked isError
    expect(result.isError).toBeUndefined();

    const text = toolText(rpc);
    const payload: unknown = JSON.parse(text);
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) return;
    expect(payload.status).toBe(200);
    expect(payload.cost).toBe(3);
    expect(typeof payload.body === "string" && payload.body).toBe(
      "echo:hello-mcp",
    );

    // Upstream called once through the same pipeline proxy path
    expect(calls).toHaveLength(1);

    // Wallet: cost reserved then settled → balance reduced, settlement pending
    const after = await walletStub(clerkOrgId).getState();
    expect(after.balance).toBe(97);
    expect(after.inFlightTotal).toBe(0);
    expect(after.pendingSettlements).toHaveLength(1);
    expect(after.pendingSettlements[0]!.cost).toBe(3);
  });

  it("caps buffered call_api responses at 1 MiB", async () => {
    const clerkOrgId = "org_mcp_response_limit";
    await installAgentFixtures({
      clerkOrgId,
      credits: 100,
      fetchImpl: async () =>
        new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
    });

    const rpc: unknown = await mcpCall(
      "tools/call",
      {
        name: "call_api",
        arguments: {
          org: ORG_SLUG,
          project: PROJECT_SLUG,
          method: "POST",
          path: "/echo",
        },
      },
      { headers: { authorization: `Bearer ${KEY_SECRET}` } },
    );

    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    expect(
      isRecord(rpc.result) &&
        rpc.result.isError === true &&
        toolText(rpc) === "Upstream response exceeds 1 MiB limit",
    ).toBe(true);
  });

  it("times out tool execution after 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      const clerkOrgId = "org_mcp_execution_limit";
      await installAgentFixtures({
        clerkOrgId,
        credits: 100,
        fetchImpl: async (input) => {
          const request =
            input instanceof Request ? input : new Request(String(input));
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
        },
      });

      const pending = mcpCall(
        "tools/call",
        {
          name: "call_api",
          arguments: {
            org: ORG_SLUG,
            project: PROJECT_SLUG,
            method: "POST",
            path: "/echo",
          },
        },
        { headers: { authorization: `Bearer ${KEY_SECRET}` } },
      );
      await vi.advanceTimersByTimeAsync(20_001);
      const rpc = await pending;

      expect(isRecord(rpc)).toBe(true);
      if (!isRecord(rpc)) return;
      expect(
        isRecord(rpc.result) &&
          rpc.result.isError === true &&
          toolText(rpc) === "Tool execution timed out after 10 seconds",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("call_api without key fails without touching wallet", async () => {
    const clerkOrgId = "org_mcp_call_nokey";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("upstream must not run");
    });
    await installAgentFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 50,
    });

    const rpc: unknown = await mcpCall("tools/call", {
      name: "call_api",
      arguments: {
        org: ORG_SLUG,
        project: PROJECT_SLUG,
        method: "POST",
        path: "/echo",
        body: "nope",
      },
    });

    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    const result = rpc.result;
    expect(isRecord(result) && result.isError === true).toBe(true);

    const text = toolText(rpc);
    expect(text.toLowerCase()).toMatch(/api key/);
    expect(calls).toHaveLength(0);

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(50);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(0);
  });

  it("call_api with insufficient credits returns 402 via pipeline", async () => {
    const clerkOrgId = "org_mcp_call_402";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("upstream must not run");
    });
    await installAgentFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 0,
    });

    const rpc: unknown = await mcpCall(
      "tools/call",
      {
        name: "call_api",
        arguments: {
          org: ORG_SLUG,
          project: PROJECT_SLUG,
          method: "POST",
          path: "/echo",
          body: "broke",
        },
      },
      { headers: { authorization: `Bearer ${KEY_SECRET}` } },
    );

    expect(isRecord(rpc)).toBe(true);
    if (!isRecord(rpc)) return;
    const result = rpc.result;
    expect(isRecord(result) && result.isError === true).toBe(true);

    const text = toolText(rpc);
    const payload: unknown = JSON.parse(text);
    expect(isRecord(payload) && payload.status === 402).toBe(true);
    expect(calls).toHaveLength(0);

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(0);
    expect(state.inFlightTotal).toBe(0);
  });
});
