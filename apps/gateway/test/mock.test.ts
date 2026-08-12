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
import { NoopUsageSink } from "../src/usage";
import type { WalletDO } from "../src/wallet";

type WalletStub = DurableObjectStub<WalletDO>;

const ORG_SLUG = "acme";
const PROJECT_SLUG = "demo";
const KEY_SECRET = "zev_test_secret_mock_1";
const KEY_ID = "ak_test_mock_1";

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
  servers: [{ url: "https://upstream.test/v1" }],
  paths: {
    "/users/{id}": {
      get: {
        "x-zevium-cost": 5,
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    active: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/example": {
      get: {
        "x-zevium-cost": 3,
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  example: { greeting: "hi" },
                },
              },
            },
          },
        },
      },
    },
    "/render": {
      post: {
        "x-zevium-cost": 20,
        responses: {
          "200": {
            content: {
              "text/html": {
                schema: {
                  type: "string",
                  example: "<h1>Rendered Markdown</h1>",
                },
              },
            },
          },
        },
      },
    },
  },
});

function walletStub(clerkOrgId: string): WalletStub {
  const id = env.WALLET.idFromName(clerkOrgId);
  return env.WALLET.get(id);
}

async function installFixtures(opts: { clerkOrgId: string; credits?: number }) {
  const keys = new FixtureKeyVerifier({
    [KEY_SECRET]: { orgId: opts.clerkOrgId, keyId: KEY_ID, scopes: ["read"] },
  });
  const specs = new FixtureSpecSource();
  specs.set(ORG_SLUG, PROJECT_SLUG, {
    spec: SPEC,
    specVersionId: "spec_version_demo_v1",
    version: "1.0.0",
    projectId: "proj_demo",
    organizationId: opts.clerkOrgId,
    clerkOrgId: opts.clerkOrgId,
    visibility: "private",
  });

  __setTestPipelineDeps({
    keyVerifier: keys,
    specSource: new FixtureSpecSource(),
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    usageSink: new NoopUsageSink(),
    idGenerator: () => `req_${crypto.randomUUID()}`,
  });

  if (opts.credits && opts.credits > 0) {
    await walletStub(opts.clerkOrgId).grant(
      `grant_${crypto.randomUUID()}`,
      opts.credits,
    );
  }
}

async function mockFetch(
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

describe("mock gateway route", () => {
  it("200 with a generated body, zero cost, no wallet delta", async () => {
    const clerkOrgId = "org_mock_happy";
    await installFixtures({ clerkOrgId, credits: 100 });

    const before = await walletStub(clerkOrgId).getState();

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/users/42`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-zevium-mock")).toBe("1");
    expect(res.headers.get("x-zevium-cost")).toBe("0");
    expect(res.headers.get("content-type")).toBe("application/json");
    const body: unknown = await res.json();
    expect(body).toEqual({ id: "string", active: true });

    const after = await walletStub(clerkOrgId).getState();
    expect(after.balance).toBe(before.balance);
    expect(after.inFlightTotal).toBe(0);
    expect(after.pendingSettlements).toHaveLength(0);
  });

  it("prefers the schema example over synthesis", async () => {
    await installFixtures({ clerkOrgId: "org_mock_example", credits: 0 });

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/example`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-zevium-cost")).toBe("0");
    expect(await res.json()).toEqual({ greeting: "hi" });
  });

  it("returns non-JSON mock bodies without JSON string quoting", async () => {
    await installFixtures({ clerkOrgId: "org_mock_html", credits: 0 });

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/render`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<h1>Rendered Markdown</h1>");
  });

  it("never reaches upstream — mock works at zero balance", async () => {
    const clerkOrgId = "org_mock_zero_balance";
    await installFixtures({ clerkOrgId, credits: 0 });

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/users/1`);
    expect(res.status).toBe(200);

    const state = await walletStub(clerkOrgId).getState();
    expect(state.balance).toBe(0);
  });

  it("keyless request serves mock (public try-before-buy surface)", async () => {
    await installFixtures({ clerkOrgId: "org_mock_keyless", credits: 10 });

    const request = new Request(
      `https://gateway.test/mock/${ORG_SLUG}/${PROJECT_SLUG}/users/1`,
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env as Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-zevium-mock")).toBe("1");
    expect(res.headers.get("x-zevium-cost")).toBe("0");
  });

  it("garbage key is ignored — mock is auth-free", async () => {
    await installFixtures({ clerkOrgId: "org_mock_badkey", credits: 10 });

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/users/1`, {
      headers: { authorization: "Bearer zev_wrong" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-zevium-mock")).toBe("1");

    const state = await walletStub("org_mock_badkey").getState();
    expect(state.balance).toBe(10);
  });

  it("404 on unknown operation", async () => {
    await installFixtures({ clerkOrgId: "org_mock_unknownop", credits: 10 });

    const res = await mockFetch(`/mock/${ORG_SLUG}/${PROJECT_SLUG}/nope`);
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("route_not_found");
  });

  it("404 on unknown project", async () => {
    await installFixtures({
      clerkOrgId: "org_mock_unknownproject",
      credits: 10,
    });

    const res = await mockFetch(`/mock/${ORG_SLUG}/missing/users/1`);
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(
      body && typeof body === "object" && "error" in body && body.error,
    ).toBe("project_not_found");
  });
});
