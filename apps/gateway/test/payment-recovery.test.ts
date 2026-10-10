import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  __setTestPipelineDeps,
  __setTestGrantsFetcher,
  type Env,
} from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureSpecSource } from "../src/spec-source";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import type { MachinePaymentDeps } from "../src/machine-payments";

const KEY = "zev_recovery_test";
const KEY_ID = "recovery_key";
const BODY = { max_tokens: 1 };
const scenarios = [
  { name: "no key", reason: "missing_api_key", key: undefined, balance: 100 },
  {
    name: "invalid key",
    reason: "invalid_api_key",
    key: "zev_unknown",
    balance: 100,
  },
  {
    name: "empty wallet",
    reason: "insufficient_credits",
    key: KEY,
    balance: 0,
  },
  {
    name: "insufficient wallet",
    reason: "insufficient_credits",
    key: KEY,
    balance: 2,
  },
  {
    name: "monthly cap",
    reason: "key_cap_exceeded",
    key: KEY,
    balance: 100,
    cap: 0,
  },
  {
    name: "in-flight budget",
    reason: "in_flight_budget_exhausted",
    key: KEY,
    balance: 100,
    token: true,
    hold: 40,
  },
  {
    name: "oversized hold",
    reason: "weight_exceeds_budget",
    key: KEY,
    balance: 10,
    token: true,
  },
  {
    name: "x402 payment required",
    reason: "missing_api_key",
    key: undefined,
    balance: 0,
    machine: true,
  },
];
const machine: MachinePaymentDeps = {
  signingSecret: "test-only-machine-session-secret-32-bytes",
  facilitator: {
    requirements: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x" + "a".repeat(40),
      amount: "1000000",
      payTo: "0x" + "b".repeat(40),
      maxTimeoutSeconds: 300,
    },
    settle: async () => {
      throw new Error("must not settle");
    },
  },
  fund: async () => {
    throw new Error("must not fund");
  },
};

afterEach(() => {
  __setTestPipelineDeps(null);
  __setTestGrantsFetcher(null);
});

async function call(surface: "direct" | "mcp", origin: string, key?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `https://gateway.test${surface === "direct" ? "/gateway/acme/demo/echo" : "/mcp"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "x-forwarded-host": "attacker.test",
        },
        body: JSON.stringify(
          surface === "direct"
            ? BODY
            : {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "call_api",
                  arguments: {
                    org: "acme",
                    project: "demo",
                    method: "POST",
                    path: "/echo",
                    body: BODY,
                  },
                },
              },
        ),
      },
    ),
    { ...env, APP_ORIGIN: origin } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const json = (await response.json()) as {
    result?: { isError?: boolean; content: Array<{ text: string }> };
  };
  if (surface === "mcp") {
    expect(response.status).toBe(200);
    expect(json.result?.isError).toBe(true);
    return { response, payload: JSON.parse(json.result!.content[0]!.text) };
  }
  expect(response.status).toBe(402);
  return { response, payload: json as Record<string, unknown> };
}

describe.each([
  "http://localhost:3000",
  "https://zevium-web-pr-42.zevium-dev.workers.dev",
  "https://zevium.dev",
])("payment recovery at %s", (origin) => {
  it.each(scenarios)(
    "preserves safe message and actions across direct/MCP: $name",
    async (scenario) => {
      const org = `recovery-${crypto.randomUUID()}`;
      const specs = new FixtureSpecSource();
      specs.set("acme", "demo", {
        projectId: "project",
        organizationId: "publisher",
        clerkOrgId: "publisher",
        specVersionId: "version",
        version: "1",
        visibility: "public",
        spec: JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Recovery", version: "1" },
          servers: [{ url: "https://upstream.test" }],
          paths: {
            "/echo": {
              post: {
                "x-zevium-cost": scenario.token
                  ? { per: "token", input: 1_000_000, output: 1_000_000 }
                  : 3,
              },
            },
          },
        }),
      });
      const upstream = vi.fn(async () => new Response("must not run"));
      __setTestPipelineDeps({
        keyVerifier: new FixtureKeyVerifier({
          [KEY]: { orgId: org, keyId: KEY_ID, scopes: [] },
        }),
        specSource: specs,
        publicSpecSource: specs,
        catalogueSource: new FixtureCatalogueSource([]),
        fetchImpl: upstream,
        machinePayments: scenario.machine ? machine : undefined,
      });
      __setTestGrantsFetcher(async () => ({
        wallet: { clerkOrgId: org, balance: scenario.balance, sequence: 0 },
        keySettings: [
          { keyId: KEY_ID, disabled: false, monthlyCapCredits: scenario.cap },
        ],
      }));
      const wallet = env.WALLET.get(env.WALLET.idFromName(org));
      if (scenario.hold) {
        expect(
          await wallet.reserve("active-call", scenario.hold, {
            keyId: KEY_ID,
            clerkOrgId: org,
          }),
        ).toMatchObject({ status: "reserved" });
      }
      const direct = await call("direct", origin, scenario.key);
      const mcp = await call("mcp", origin, scenario.key);
      expect(direct.payload).toMatchObject({
        reason: scenario.reason,
        message: expect.any(String),
        detail: expect.any(String),
        recovery: expect.any(String),
        actions: expect.any(Object),
      });
      expect(mcp.payload).toMatchObject({
        status: 402,
        cost: 0,
        error: direct.payload.error,
        reason: scenario.reason,
        message: direct.payload.message,
        detail: direct.payload.detail,
        recovery: direct.payload.recovery,
        actions: direct.payload.actions,
      });
      expect(mcp.payload.requiredCredits).toBe(direct.payload.cost);
      expect(mcp.payload.available).toBe(direct.payload.available);
      for (const url of Object.values(
        direct.payload.actions as Record<string, string>,
      ))
        expect(new URL(url).origin).toBe(origin);
      if (scenario.reason === "key_cap_exceeded") {
        expect(mcp.payload.recovery).toMatch(
          /admin.*monthly cap.*next UTC month/,
        );
        expect(mcp.payload.actions).toEqual({
          manageKey: `${origin}/app/settings/keys`,
          docs: `${origin}/docs/consuming`,
        });
      }
      if (scenario.reason === "in_flight_budget_exhausted") {
        expect(direct.response.headers.get("Retry-After")).toBe("5");
        expect(mcp.payload.retryAfterSeconds).toBe(5);
      }
      if (scenario.machine) {
        expect(mcp.payload.paymentRequired).toBe(
          direct.response.headers.get("PAYMENT-REQUIRED"),
        );
        expect(JSON.parse(atob(mcp.payload.paymentRequired))).toMatchObject({
          x402Version: 2,
        });
      }
      expect(upstream).not.toHaveBeenCalled();
      const state = await wallet.getState();
      expect(state.pendingSettlements).toEqual([]);
      expect(state.inFlightTotal).toBe(scenario.hold ?? 0);
    },
  );
});
