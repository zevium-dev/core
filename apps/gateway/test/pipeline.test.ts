import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, { __setTestPipelineDeps, type Env } from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureSpecSource } from "../src/spec-source";
import { CollectingUsageSink } from "../src/usage";
import type { WalletDO } from "../src/wallet";

type WalletStub = DurableObjectStub<WalletDO>;

const ORG_SLUG = "acme";
const PROJECT_SLUG = "demo";
const KEY_SECRET = "zev_test_secret_pipeline_1";
const KEY_ID = "ak_test_1";

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
  servers: [{ url: "https://upstream.test/v1" }],
  paths: {
    "/echo": {
      post: {
        "x-zevium-cost": 3,
      },
    },
    "/stream": {
      get: {
        "x-zevium-cost": 2,
      },
    },
    "/fail": {
      get: {
        "x-zevium-cost": 4,
      },
    },
    "/users/{id}": {
      get: {
        "x-zevium-cost": 1,
      },
    },
  },
});

function walletStub(orgId: string): WalletStub {
  const id = env.WALLET.idFromName(orgId);
  return env.WALLET.get(id);
}

function makeFetchMock(handler: (req: Request) => Promise<Response> | Response) {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    calls.push(req);
    return handler(req);
  };
  return { fetchImpl, calls };
}

async function installFixtures(opts: {
  orgId: string;
  fetchImpl: typeof fetch;
  credits?: number;
  usage?: CollectingUsageSink;
}) {
  const usage = opts.usage ?? new CollectingUsageSink();
  const keys = new FixtureKeyVerifier({
    [KEY_SECRET]: { orgId: opts.orgId, keyId: KEY_ID, scopes: ["read"] },
  });
  const specs = new FixtureSpecSource();
  specs.set(ORG_SLUG, PROJECT_SLUG, {
    spec: SPEC,
    projectId: "proj_demo",
    organizationId: opts.orgId,
  });

  __setTestPipelineDeps({
    keyVerifier: keys,
    specSource: specs,
    usageSink: usage,
    fetchImpl: opts.fetchImpl,
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });

  if (opts.credits && opts.credits > 0) {
    await walletStub(opts.orgId).grant(
      `grant_${crypto.randomUUID()}`,
      opts.credits,
    );
  }

  return { usage, keys, specs };
}

async function gatewayFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization") && !headers.has("x-api-key")) {
    headers.set("authorization", `Bearer ${KEY_SECRET}`);
  }
  const request = new Request(`https://gateway.test${path}`, {
    ...init,
    headers,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => {
  __setTestPipelineDeps(null);
});

describe("gateway pipeline", () => {
  it("happy path: reserves, proxies, settles, sets headers", async () => {
    const orgId = "org_pipe_happy";
    const { fetchImpl, calls } = makeFetchMock(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/echo");
      expect(req.headers.get("authorization")).toBeNull();
      expect(req.headers.get("x-api-key")).toBeNull();
      const body = await req.text();
      return new Response(`echo:${body}`, {
        status: 200,
        headers: { "content-type": "text/plain", "x-upstream": "yes" },
      });
    });

    const { usage } = await installFixtures({
      orgId,
      fetchImpl,
      credits: 100,
    });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:hello");
    expect(res.headers.get("x-zevium-cost")).toBe("3");
    expect(res.headers.get("x-zevium-request-id")).toBeTruthy();
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(calls).toHaveLength(1);

    const state = await walletStub(orgId).getState();
    expect(state.balance).toBe(97);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(1);

    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]!.outcome).toBe("settled");
    expect(usage.events[0]!.cost).toBe(3);
    expect(usage.events[0]!.status).toBe(200);
  });

  it("insufficient credits → 402 and no upstream call", async () => {
    const orgId = "org_pipe_insufficient";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("upstream should not be called");
    });

    const { usage } = await installFixtures({
      orgId,
      fetchImpl,
      credits: 0,
    });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      body: "nope",
    });

    expect(res.status).toBe(402);
    const body: unknown = await res.json();
    expect(body && typeof body === "object" && "error" in body && body.error).toBe(
      "insufficient_credits",
    );
    expect(calls).toHaveLength(0);
    expect(usage.events[0]!.outcome).toBe("blocked");

    const state = await walletStub(orgId).getState();
    expect(state.balance).toBe(0);
    expect(state.inFlightTotal).toBe(0);
  });

  it("non-2xx upstream → refund, credits restored", async () => {
    const orgId = "org_pipe_refund";
    const { fetchImpl } = makeFetchMock(
      () => new Response("boom", { status: 500 }),
    );

    await installFixtures({ orgId, fetchImpl, credits: 50 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/fail`);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-zevium-cost")).toBe("4");
    expect(await res.text()).toBe("boom");

    const state = await walletStub(orgId).getState();
    expect(state.balance).toBe(50);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(0);
  });

  it("streaming body passthrough integrity", async () => {
    const orgId = "org_pipe_stream";
    const chunks = ["alpha-", "beta-", "gamma"];
    const { fetchImpl } = makeFetchMock(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });

    await installFixtures({ orgId, fetchImpl, credits: 20 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alpha-beta-gamma");

    const state = await walletStub(orgId).getState();
    expect(state.balance).toBe(18);
  });

  it("path template match + x-api-key auth", async () => {
    const orgId = "org_pipe_path";
    const { fetchImpl, calls } = makeFetchMock(
      (req) =>
        new Response(new URL(req.url).pathname, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await installFixtures({ orgId, fetchImpl, credits: 10 });

    const headers = new Headers({ "x-api-key": KEY_SECRET });
    const request = new Request(
      `https://gateway.test/gateway/${ORG_SLUG}/${PROJECT_SLUG}/users/42`,
      { headers },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env as Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/v1/users/42");
    expect(calls).toHaveLength(1);
  });

  it("401 on bad key", async () => {
    const orgId = "org_pipe_badkey";
    const { fetchImpl, calls } = makeFetchMock(() => new Response("x"));
    await installFixtures({ orgId, fetchImpl, credits: 10 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      headers: { authorization: "Bearer zev_wrong" },
      body: "x",
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("404 unknown project", async () => {
    const orgId = "org_pipe_missing";
    const { fetchImpl } = makeFetchMock(() => new Response("x"));
    await installFixtures({ orgId, fetchImpl, credits: 10 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/missing/echo`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(404);
  });

  it("wallet HTTP grant endpoint works for tests", async () => {
    const org = "org_http_grant";
    const stub = walletStub(org);

    const ctx = createExecutionContext();
    const grantRes = await worker.fetch(
      new Request(`https://gateway.test/wallet/${org}/grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantId: "g-http-1", amount: 25 }),
      }),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(grantRes.status).toBe(200);
    const grantJson: unknown = await grantRes.json();
    expect(
      grantJson &&
        typeof grantJson === "object" &&
        "status" in grantJson &&
        grantJson.status,
    ).toBe("applied");
    expect(
      grantJson &&
        typeof grantJson === "object" &&
        "balance" in grantJson &&
        grantJson.balance,
    ).toBe(25);

    const state = await stub.getState();
    expect(state.balance).toBe(25);
  });
});
