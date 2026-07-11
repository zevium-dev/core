import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  __setTestPipelineDeps,
  __setTestUsageMutation,
  type Env,
} from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureSpecSource } from "../src/spec-source";
import {
  CollectingUsageSink,
  FakeConvexUsageSink,
} from "../src/usage";
import type { WalletDO } from "../src/wallet";

type WalletStub = DurableObjectStub<WalletDO>;

const ORG_SLUG = "acme";
const PROJECT_SLUG = "demo";
const KEY_SECRET = "zev_test_secret_pipeline_1";
const KEY_ID = "ak_test_1";
const CLERK_ORG = "org_clerk_pipe";
const CONVEX_ORG = "org_convex_pipe";

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
    "/free": {
      get: {
        "x-zevium-cost": 5,
        "x-zevium-free-tier": 2,
      },
    },
  },
});

function walletStub(clerkOrgId: string): WalletStub {
  const id = env.WALLET.idFromName(clerkOrgId);
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
  clerkOrgId: string;
  organizationId?: string;
  fetchImpl: typeof fetch;
  credits?: number;
  usage?: CollectingUsageSink;
  keyOrgId?: string;
}) {
  const usage = opts.usage ?? new CollectingUsageSink();
  const organizationId = opts.organizationId ?? opts.clerkOrgId;
  const keys = new FixtureKeyVerifier({
    [KEY_SECRET]: {
      orgId: opts.keyOrgId ?? opts.clerkOrgId,
      keyId: KEY_ID,
      scopes: ["read"],
    },
  });
  const specs = new FixtureSpecSource();
  specs.set(ORG_SLUG, PROJECT_SLUG, {
    spec: SPEC,
    projectId: "proj_demo",
    organizationId,
    clerkOrgId: opts.clerkOrgId,
  });

  __setTestPipelineDeps({
    keyVerifier: keys,
    specSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    usageSink: usage,
    fetchImpl: opts.fetchImpl,
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });

  if (opts.credits && opts.credits > 0) {
    await walletStub(opts.clerkOrgId).grant(
      `grant_${crypto.randomUUID()}`,
      opts.credits,
    );
  }

  return { usage, keys, specs, organizationId };
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
  __setTestUsageMutation(null);
});

describe("gateway pipeline", () => {
  it("happy path: reserves, proxies, settles, sets headers", async () => {
    const clerkOrgId = "org_pipe_happy";
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
      clerkOrgId,
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

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(97);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(1);
    expect(state.pendingSettlements[0]!.usage).toBeTruthy();

    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]!.outcome).toBe("settled");
    expect(usage.events[0]!.cost).toBe(3);
    expect(usage.events[0]!.status).toBe(200);
  });

  it("insufficient credits → 402 and no upstream call", async () => {
    const clerkOrgId = "org_pipe_insufficient";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("upstream should not be called");
    });

    const { usage } = await installFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 0,
    });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      body: "nope",
    });

    expect(res.status).toBe(402);
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("insufficient_credits");
    expect(calls).toHaveLength(0);
    expect(usage.events[0]!.outcome).toBe("blocked");

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(0);
    expect(state.inFlightTotal).toBe(0);
  });

  it("non-2xx upstream → refund, credits restored", async () => {
    const clerkOrgId = "org_pipe_refund";
    const { fetchImpl } = makeFetchMock(
      () => new Response("boom", { status: 500 }),
    );

    await installFixtures({ clerkOrgId, fetchImpl, credits: 50 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/fail`);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-zevium-cost")).toBe("4");
    expect(await res.text()).toBe("boom");

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(50);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(0);
  });

  it("streaming body passthrough integrity", async () => {
    const clerkOrgId = "org_pipe_stream";
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

    await installFixtures({ clerkOrgId, fetchImpl, credits: 20 });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alpha-beta-gamma");

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(18);
  });

  it("path template match + x-api-key auth", async () => {
    const clerkOrgId = "org_pipe_path";
    const { fetchImpl, calls } = makeFetchMock(
      (req) =>
        new Response(new URL(req.url).pathname, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await installFixtures({ clerkOrgId, fetchImpl, credits: 10 });

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
    const clerkOrgId = "org_pipe_badkey";
    const { fetchImpl, calls } = makeFetchMock(() => new Response("x"));
    await installFixtures({ clerkOrgId, fetchImpl, credits: 10 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      headers: { authorization: "Bearer zev_wrong" },
      body: "x",
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("404 unknown project", async () => {
    const clerkOrgId = "org_pipe_missing";
    const { fetchImpl } = makeFetchMock(() => new Response("x"));
    await installFixtures({ clerkOrgId, fetchImpl, credits: 10 });

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

  it("free-tier path skips reserve, costs 0, still enqueues usage", async () => {
    const clerkOrgId = "org_pipe_free";
    const organizationId = "org_convex_free";
    const { fetchImpl, calls } = makeFetchMock(
      () => new Response("free-ok", { status: 200 }),
    );

    // Zero credits — free path must still work.
    const { usage } = await installFixtures({
      clerkOrgId,
      organizationId,
      fetchImpl,
      credits: 0,
    });

    const res1 = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-zevium-cost")).toBe("0");
    expect(res1.headers.get("x-zevium-free-tier")).toBe("1");
    expect(await res1.text()).toBe("free-ok");

    const res2 = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-zevium-free-tier")).toBe("1");

    // Free tier exhausted (limit 2) → paid path → 402 at zero balance.
    const res3 = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`);
    expect(res3.status).toBe(402);

    expect(calls).toHaveLength(2);

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(0);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(2);
    expect(state.pendingSettlements.every((s) => s.cost === 0)).toBe(true);

    const freeEvents = usage.events.filter((e) => e.outcome === "free");
    expect(freeEvents).toHaveLength(2);
    expect(freeEvents.every((e) => e.cost === 0)).toBe(true);
  });

  it("flush batching with ack via DO alarm + fake convex sink", async () => {
    const clerkOrgId = "org_pipe_flush";
    const organizationId = "org_convex_flush";
    const fake = new FakeConvexUsageSink();
    __setTestUsageMutation(fake.asMutationFn());

    const { fetchImpl } = makeFetchMock(
      () => new Response("ok", { status: 200 }),
    );
    await installFixtures({
      clerkOrgId,
      organizationId,
      fetchImpl,
      credits: 50,
    });

    await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`, {
      method: "POST",
      body: "a",
    });
    await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`);

    const stub = walletStub(clerkOrgId);
    let state = await stub.getState();
    expect(state.pendingSettlements).toHaveLength(2);
    expect(state.balance).toBe(45); // 50 - 3 - 2

    // Drive alarm-based flush.
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    state = await stub.getState();
    expect(state.pendingSettlements).toHaveLength(0);
    expect(fake.batches.length).toBeGreaterThanOrEqual(1);
    expect(fake.records).toHaveLength(2);
    expect(fake.records.map((r) => r.credits).sort()).toEqual([2, 3]);
    expect(fake.records.every((r) => r.organizationId === organizationId)).toBe(
      true,
    );

    // Second flush sees empty pending, no extra records.
    const again = await stub.flushToConvex();
    expect(again.flushed).toBe(0);
    expect(fake.records).toHaveLength(2);
  });

  it("flush fails without convex then succeeds after sink wired", async () => {
    const clerkOrgId = "org_pipe_flush_retry";
    const organizationId = "org_convex_flush_retry";
    const fake = new FakeConvexUsageSink();

    const { fetchImpl } = makeFetchMock(
      () => new Response("ok", { status: 200 }),
    );
    await installFixtures({
      clerkOrgId,
      organizationId,
      fetchImpl,
      credits: 20,
    });

    await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`);
    const stub = walletStub(clerkOrgId);

    // No mutation hook + no CONVEX_URL → soft error, pending kept.
    const fail = await stub.flushToConvex();
    expect(fail.error).toBe("convex client not configured");
    expect(fail.acked).toBe(0);
    expect((await stub.getState()).pendingSettlements).toHaveLength(1);

    __setTestUsageMutation(fake.asMutationFn());
    const ok = await stub.flushToConvex();
    expect(ok.error).toBeUndefined();
    expect(ok.acked).toBe(1);
    expect((await stub.getState()).pendingSettlements).toHaveLength(0);
    expect(fake.records).toHaveLength(1);
    expect(fake.records[0]!.credits).toBe(2);
  });

  it("internal grant endpoint auth + DO credit", async () => {
    const clerkOrgId = "org_internal_grant";
    const secret = "test-internal-secret";
    const testEnv = {
      ...env,
      GATEWAY_INTERNAL_SECRET: secret,
    } as Env;

    const unauth = await worker.fetch(
      new Request("https://gateway.test/internal/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clerkOrgId,
          amount: 10,
          refId: "ref-1",
        }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(unauth.status).toBe(401);

    const badSecret = await worker.fetch(
      new Request("https://gateway.test/internal/grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": "wrong",
        },
        body: JSON.stringify({
          clerkOrgId,
          amount: 10,
          refId: "ref-1",
        }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(badSecret.status).toBe(401);

    const okCtx = createExecutionContext();
    const ok = await worker.fetch(
      new Request("https://gateway.test/internal/grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": secret,
        },
        body: JSON.stringify({
          clerkOrgId,
          amount: 42,
          refId: "ref-grant-1",
        }),
      }),
      testEnv,
      okCtx,
    );
    await waitOnExecutionContext(okCtx);
    expect(ok.status).toBe(200);
    const body: unknown = await ok.json();
    expect(
      body && typeof body === "object" && "status" in body && body.status,
    ).toBe("applied");
    expect(
      body && typeof body === "object" && "balance" in body && body.balance,
    ).toBe(42);

    // Idempotent on refId
    const dup = await worker.fetch(
      new Request("https://gateway.test/internal/grant", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": secret,
        },
        body: JSON.stringify({
          clerkOrgId,
          amount: 42,
          refId: "ref-grant-1",
        }),
      }),
      testEnv,
      createExecutionContext(),
    );
    const dupBody: unknown = await dup.json();
    expect(
      dupBody &&
        typeof dupBody === "object" &&
        "status" in dupBody &&
        dupBody.status,
    ).toBe("duplicate");

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(42);
  });

  it("wallet DO uses clerkOrgId not convex organizationId", async () => {
    const { fetchImpl } = makeFetchMock(
      () => new Response("ok", { status: 200 }),
    );
    await installFixtures({
      clerkOrgId: CLERK_ORG,
      organizationId: CONVEX_ORG,
      fetchImpl,
      credits: 10,
    });

    await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`);

    // Credits landed on clerk-named DO, not convex id DO.
    const clerkState = await walletStub(CLERK_ORG).getState();
    expect(clerkState.balance).toBe(8);

    const convexNamed = await walletStub(CONVEX_ORG).getState();
    expect(convexNamed.balance).toBe(0);
  });
});
