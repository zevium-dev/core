import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  __setTestPipelineDeps,
  __setTestGrantsFetcher,
  __setTestUsageMutation,
  type Env,
} from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { FixtureSpecSource } from "../src/spec-source";
import { CollectingUsageSink, FakeConvexUsageSink } from "../src/usage";
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
    "/zero": {
      get: {
        "x-zevium-cost": 0,
        "x-zevium-free-tier": 1,
      },
    },
  },
});

function walletStub(clerkOrgId: string): WalletStub {
  const id = env.WALLET.idFromName(clerkOrgId);
  return env.WALLET.get(id);
}

function freeScope(clerkOrgId: string) {
  return {
    clerkOrgId,
    projectId: "proj_demo",
    method: "GET",
    pathTemplate: "/free",
  };
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

async function installFixtures(opts: {
  clerkOrgId: string;
  organizationId?: string;
  fetchImpl: typeof fetch;
  credits?: number;
  usage?: CollectingUsageSink;
  keyOrgId?: string;
  /** Grant credits to this org's wallet instead of clerkOrgId (cross-org tests). */
  creditOrgId?: string;
  visibility?: "public" | "private";
  deprecatedAt?: number;
  sunsetAt?: number;
  deprecationMessage?: string;
  upstreamHeaders?: Record<string, string>;
  spec?: string;
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
    spec: opts.spec ?? SPEC,
    projectId: "proj_demo",
    organizationId,
    clerkOrgId: opts.clerkOrgId,
    visibility: opts.visibility ?? "private",
    deprecatedAt: opts.deprecatedAt,
    sunsetAt: opts.sunsetAt,
    deprecationMessage: opts.deprecationMessage,
    upstreamHeaders: opts.upstreamHeaders,
  });

  __setTestPipelineDeps({
    keyVerifier: keys,
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    usageSink: usage,
    fetchImpl: opts.fetchImpl,
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });

  if (opts.credits && opts.credits > 0) {
    await walletStub(opts.creditOrgId ?? opts.clerkOrgId).grant(
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
  __setTestGrantsFetcher(null);
  __setTestUsageMutation(null);
});

describe("gateway pipeline", () => {
  it("rejects an unsafe upstream before a credit reservation or fetch", async () => {
    const clerkOrgId = "org_pipe_unsafe";
    const { fetchImpl, calls } = makeFetchMock(() => new Response("no"));
    const unsafeSpec = JSON.stringify({
      ...JSON.parse(SPEC),
      servers: [{ url: "https://127.0.0.1" }],
    });
    const { usage } = await installFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 100,
      spec: unsafeSpec,
    });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
    expect(usage.events).toHaveLength(0);
    expect((await walletStub(clerkOrgId).getState()).balance).toBe(100);
  });

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

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo:hello");
    expect(res.headers.get("x-zevium-cost")).toBe("3");
    expect(res.headers.get("x-zevium-request-id")).toBeTruthy();
    expect(res.headers.get("x-upstream")).toBe("yes");
    // Non-deprecated spec: no RFC 8594 deprecation signalling.
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
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

  it("strips consumer auth and injects publisher upstream credentials", async () => {
    const clerkOrgId = "org_pipe_upstream_auth";
    const { fetchImpl } = makeFetchMock((req) => {
      expect(req.headers.get("authorization")).toBe("Bearer publisher-secret");
      expect(req.headers.get("x-api-key")).toBe("publisher-api-key");
      return new Response("ok");
    });
    await installFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 100,
      upstreamHeaders: {
        authorization: "Bearer publisher-secret",
        "x-api-key": "publisher-api-key",
      },
    });

    const response = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY_SECRET}`,
          "x-api-key": "consumer-must-not-reach-upstream",
        },
        body: "hello",
      },
    );
    expect(response.status).toBe(200);
  });

  it("deprecated spec → RFC 8594 deprecation/sunset/link headers", async () => {
    const clerkOrgId = "org_pipe_deprecated";
    const { fetchImpl } = makeFetchMock(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    // Convex stamps epoch milliseconds (Date.now()); gateway converts.
    const deprecatedAt = 1_750_000_000_000;
    const sunsetAt = 1_800_000_000_000;
    await installFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 50,
      deprecatedAt,
      sunsetAt,
      deprecationMessage: "v1 is setting sun",
    });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(res.headers.get("Deprecation")).toBe(
      `@${Math.floor(deprecatedAt / 1000)}`,
    );
    expect(res.headers.get("Sunset")).toBe(new Date(sunsetAt).toUTCString());
    const link = res.headers.get("Link");
    expect(link).toContain(
      `<https://zevium.dev/catalogue/${ORG_SLUG}/${PROJECT_SLUG}>`,
    );
    expect(link).toContain('rel="deprecation"');

    // Billing unaffected by deprecation signalling.
    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(48); // 50 - 2 (stream cost)
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

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      {
        method: "POST",
        body: "nope",
      },
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="zevium"');
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("payment_required");
    expect(
      body && typeof body === "object" && "reason" in body && body.reason,
    ).toBe("insufficient_credits");
    expect(
      body && typeof body === "object" && "actions" in body && body.actions,
    ).toMatchObject({
      createKey: "https://zevium.dev/app/settings/keys",
      topUp: "https://zevium.dev/app/billing",
      docs: "https://zevium.dev/docs/consuming",
    });
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

  it("402 (x402 payment_required, not 401) on bad key", async () => {
    const clerkOrgId = "org_pipe_badkey";
    const { fetchImpl, calls } = makeFetchMock(() => new Response("x"));
    await installFixtures({ clerkOrgId, fetchImpl, credits: 10 });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      {
        method: "POST",
        headers: { authorization: "Bearer zev_wrong" },
        body: "x",
      },
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="zevium"');
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("payment_required");
    expect(
      body && typeof body === "object" && "actions" in body && body.actions,
    ).toMatchObject({
      createKey: "https://zevium.dev/app/settings/keys",
      topUp: "https://zevium.dev/app/billing",
      docs: "https://zevium.dev/docs/consuming",
    });
    expect(calls).toHaveLength(0);
  });

  it("402 (x402 payment_required, not 401) on missing key", async () => {
    const clerkOrgId = "org_pipe_missingkey";
    const { fetchImpl, calls } = makeFetchMock(() => new Response("x"));
    await installFixtures({ clerkOrgId, fetchImpl, credits: 10 });

    const request = new Request(
      `https://gateway.test/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      { method: "POST", body: "x" },
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env as Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="zevium"');
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

  it("anonymous wallet administration routes do not mutate DO state", async () => {
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

    expect(grantRes.status).toBe(404);

    const stateRes = await worker.fetch(
      new Request(`https://gateway.test/wallet/${org}/state`),
      env as Env,
      createExecutionContext(),
    );
    expect(stateRes.status).toBe(404);

    const state = await stub.getState();
    expect(state.balance).toBe(0);
    expect(state.inFlightTotal).toBe(0);
  });

  it("zero balance blocks free-tier upstream without consuming allowance", async () => {
    const clerkOrgId = "org_pipe_free";
    const organizationId = "org_convex_free";
    const { fetchImpl, calls } = makeFetchMock(
      () => new Response("free-ok", { status: 200 }),
    );

    const { usage } = await installFixtures({
      clerkOrgId,
      organizationId,
      fetchImpl,
      credits: 0,
    });

    const res1 = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );
    expect(res1.status).toBe(402);
    expect(calls).toHaveLength(0);
    expect(
      await walletStub(clerkOrgId).getFreeTierUsed(freeScope(clerkOrgId)),
    ).toBe(0);

    await walletStub(clerkOrgId).grant("free-tier-positive-balance", 1);
    const res2 = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );
    const res3 = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );
    const res4 = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );

    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
    expect(res4.status).toBe(402);
    expect(calls).toHaveLength(2);

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(1);
    expect(state.inFlightTotal).toBe(0);
    expect(state.pendingSettlements).toHaveLength(2);
    expect(
      await walletStub(clerkOrgId).getFreeTierUsed(freeScope(clerkOrgId)),
    ).toBe(2);

    expect(usage.events).toContainEqual(
      expect.objectContaining({ outcome: "blocked", status: 402, cost: 0 }),
    );
    expect(
      usage.events.filter((event) => event.outcome === "free"),
    ).toHaveLength(2);
  });

  it("zero balance blocks zero-cost upstream", async () => {
    const clerkOrgId = "org_pipe_zero_cost";
    const { fetchImpl, calls } = makeFetchMock(
      () => new Response("zero-cost", { status: 200 }),
    );
    await installFixtures({ clerkOrgId, fetchImpl, credits: 0 });

    const response = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/zero`,
    );
    expect(response.status).toBe(402);

    expect(calls).toHaveLength(0);
    expect(
      await walletStub(clerkOrgId).getFreeTierUsed({
        clerkOrgId,
        projectId: "proj_demo",
        method: "GET",
        pathTemplate: "/zero",
      }),
    ).toBe(0);

    await walletStub(clerkOrgId).grant("zero-cost-positive-balance", 1);
    const allowed = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/zero`,
    );
    expect(allowed.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await walletStub(clerkOrgId).getState()).balance).toBe(1);
  });

  it("disabled and expired-grace keys cannot use the free tier upstream", async () => {
    for (const [label, setting] of [
      ["disabled", { keyId: KEY_ID, disabled: true }],
      ["grace-expired", { keyId: KEY_ID, disabled: false, graceUntil: 0 }],
    ] as const) {
      const clerkOrgId = `org_pipe_free_${label}`;
      const { fetchImpl, calls } = makeFetchMock(
        () => new Response("should not run"),
      );
      __setTestGrantsFetcher(async () => ({
        wallet: { clerkOrgId, balance: 0, sequence: 1 },
        keySettings: [setting],
      }));
      await installFixtures({ clerkOrgId, fetchImpl, credits: 0 });

      const res = await gatewayFetch(
        `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
      );

      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(
        await walletStub(clerkOrgId).getFreeTierUsed(freeScope(clerkOrgId)),
      ).toBe(0);
      __setTestGrantsFetcher(null);
    }
  });

  it("returns free-tier allowance after 4xx and 5xx upstream responses", async () => {
    const clerkOrgId = "org_pipe_free_refund";
    const statuses = [400, 503];
    const { fetchImpl, calls } = makeFetchMock(() => {
      const status = statuses.shift();
      return new Response("upstream failure", { status });
    });
    const { usage } = await installFixtures({
      clerkOrgId,
      fetchImpl,
      credits: 1,
    });

    const first = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );
    const second = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`,
    );

    expect(first.status).toBe(400);
    expect(second.status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(
      await walletStub(clerkOrgId).getFreeTierUsed(freeScope(clerkOrgId)),
    ).toBe(0);
    expect(usage.events.map((event) => event.outcome)).toEqual([
      "refunded",
      "refunded",
    ]);
    expect(
      (await walletStub(clerkOrgId).getState()).pendingSettlements,
    ).toHaveLength(0);
  });

  it("returns free-tier allowance when the upstream request throws", async () => {
    const clerkOrgId = "org_pipe_free_transport_failure";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("connection reset");
    });
    await installFixtures({ clerkOrgId, fetchImpl, credits: 1 });

    const res = await gatewayFetch(`/gateway/${ORG_SLUG}/${PROJECT_SLUG}/free`);

    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(
      await walletStub(clerkOrgId).getFreeTierUsed(freeScope(clerkOrgId)),
    ).toBe(0);
  });

  it("flush batching with ack via DO alarm + fake convex sink", async () => {
    const clerkOrgId = "org_pipe_flush";
    const organizationId = "org_convex_flush";
    const fake = new FakeConvexUsageSink();
    fake.setWallet(clerkOrgId, 50);
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
    const organizationRecords = fake.records.filter(
      (record) => record.organizationId === organizationId,
    );
    expect(organizationRecords).toHaveLength(2);
    expect(organizationRecords.map((record) => record.credits).sort()).toEqual([
      2, 3,
    ]);

    // Second flush sees empty pending, no extra records.
    const again = await stub.flushToConvex();
    expect(again.flushed).toBe(0);
    expect(
      fake.records.filter((record) => record.organizationId === organizationId),
    ).toHaveLength(2);
  });

  it("flush fails without convex then succeeds after sink wired", async () => {
    const clerkOrgId = "org_pipe_flush_retry";
    const organizationId = "org_convex_flush_retry";
    const fake = new FakeConvexUsageSink();
    fake.setWallet(clerkOrgId, 20);

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
    const organizationRecords = fake.records.filter(
      (record) => record.organizationId === organizationId,
    );
    expect(organizationRecords).toHaveLength(1);
    expect(organizationRecords[0]!.credits).toBe(2);
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

  it("internal sync requires the shared secret and imports a checkpoint", async () => {
    const clerkOrgId = "org_internal_sync";
    const secret = "test-internal-secret";
    const testEnv = {
      ...env,
      GATEWAY_INTERNAL_SECRET: secret,
    } as Env;
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId, balance: 42, sequence: 1 },
      keySettings: [],
    }));

    const unauth = await worker.fetch(
      new Request("https://gateway.test/internal/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clerkOrgId }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(unauth.status).toBe(401);
    expect((await walletStub(clerkOrgId).getState()).balance).toBe(0);

    const sync = await worker.fetch(
      new Request("https://gateway.test/internal/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": secret,
        },
        body: JSON.stringify({ clerkOrgId }),
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({
      status: "ok",
      balance: 42,
      sequence: 1,
    });
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

  it("a negative authoritative wallet checkpoint blocks paid execution", async () => {
    const clerkOrgId = "org_pipe_negative_checkpoint";
    const { fetchImpl, calls } = makeFetchMock(
      () => new Response("should not run"),
    );
    __setTestGrantsFetcher(async () => ({
      wallet: { clerkOrgId, balance: -10, sequence: 1 },
      keySettings: [],
    }));
    await installFixtures({ clerkOrgId, fetchImpl, credits: 0 });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/echo`,
      { method: "POST", body: "request" },
    );

    expect(res.status).toBe(402);
    expect(calls).toHaveLength(0);
    expect((await walletStub(clerkOrgId).getState()).available).toBe(0);
  });

  it("marketplace: consumer key calls a PUBLIC project in another org, consumer wallet pays", async () => {
    const publisherOrg = "org_pipe_publisher_b";
    const consumerOrg = "org_pipe_consumer_a";
    const { fetchImpl, calls } = makeFetchMock(
      () => new Response("ok", { status: 200 }),
    );

    const { usage } = await installFixtures({
      clerkOrgId: publisherOrg,
      keyOrgId: consumerOrg,
      visibility: "public",
      fetchImpl,
      credits: 20,
      creditOrgId: consumerOrg,
    });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);

    // Consumer's wallet is debited, not the publisher's.
    const consumerState = await walletStub(consumerOrg).getState();
    expect(consumerState.balance).toBe(18); // 20 - 2 (stream cost)
    expect(consumerState.pendingSettlements).toHaveLength(1);

    const publisherState = await walletStub(publisherOrg).getState();
    expect(publisherState.balance).toBe(0);
    expect(publisherState.pendingSettlements).toHaveLength(0);

    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]!.outcome).toBe("settled");
    expect(usage.events[0]!.cost).toBe(2);
    expect(usage.events[0]!.consumerClerkOrgId).toBe(consumerOrg);
  });

  it("marketplace: PRIVATE project, foreign key → 404 project_not_found, no wallet activity", async () => {
    const publisherOrg = "org_pipe_private_pub";
    const foreignOrg = "org_pipe_private_foreign";
    const { fetchImpl, calls } = makeFetchMock(() => {
      throw new Error("upstream should not be called");
    });

    const { usage } = await installFixtures({
      clerkOrgId: publisherOrg,
      keyOrgId: foreignOrg,
      visibility: "private",
      fetchImpl,
      credits: 20,
      creditOrgId: foreignOrg,
    });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("project_not_found");
    // Never leak that the private project exists via a 401/403.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(calls).toHaveLength(0);
    expect(usage.events).toHaveLength(0);

    const foreignState = await walletStub(foreignOrg).getState();
    expect(foreignState.balance).toBe(20); // untouched
    expect(foreignState.inFlightTotal).toBe(0);
    expect(foreignState.pendingSettlements).toHaveLength(0);

    const publisherState = await walletStub(publisherOrg).getState();
    expect(publisherState.balance).toBe(0);
    expect(publisherState.pendingSettlements).toHaveLength(0);
  });

  it("marketplace: PRIVATE project, owner key → 200", async () => {
    const publisherOrg = "org_pipe_private_owner";
    const { fetchImpl } = makeFetchMock(
      () => new Response("ok", { status: 200 }),
    );

    await installFixtures({
      clerkOrgId: publisherOrg,
      visibility: "private",
      fetchImpl,
      credits: 10,
    });

    const res = await gatewayFetch(
      `/gateway/${ORG_SLUG}/${PROJECT_SLUG}/stream`,
    );
    expect(res.status).toBe(200);

    const state = await walletStub(publisherOrg).getState();
    expect(state.balance).toBe(8); // 10 - 2 (stream cost)
  });
});
