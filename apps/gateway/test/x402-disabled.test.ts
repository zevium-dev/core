import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  __resetProdDepsCache,
  __setTestPipelineDeps,
  type Env,
} from "../src/index";
import { FixtureKeyVerifier } from "../src/key-verifier";
import { FixtureSpecSource } from "../src/spec-source";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import { issueWalletSession } from "../src/wallet-session";
import { paymentHeader } from "../src/machine-payments";

const signingSecret = "test-only-session-secret-at-least-32-characters";
const configured: Env = {
  ...env,
  X402_ENABLED: undefined,
  X402_DEPOSIT_ADDRESS: "0x" + "b".repeat(40),
  X402_FACILITATOR_URL: "https://facilitator.invalid",
  X402_FACILITATOR_TOKEN: "test-facilitator-token",
  X402_STRIPE_SECRET_KEY: "rk_test_fixture",
  WALLET_SESSION_SECRET: signingSecret,
  CONVEX_SITE_URL: "https://control.invalid",
  GATEWAY_INTERNAL_SECRET: "test-internal-secret",
};
const target = "https://gateway.test/gateway/acme/api/echo";

async function call(request: Request, bindings = configured) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function mcp(method: string, params?: unknown, headers?: HeadersInit) {
  return new Request("https://gateway.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
function fixtures() {
  const settle = vi.fn();
  const fund = vi.fn();
  const upstream = vi.fn();
  const specs = new FixtureSpecSource();
  __setTestPipelineDeps({
    keyVerifier: new FixtureKeyVerifier(),
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    fetchImpl: upstream,
    machinePayments: {
      signingSecret,
      facilitator: {
        requirements: {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x" + "a".repeat(40),
          amount: "1000000",
          payTo: configured.X402_DEPOSIT_ADDRESS!,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
        settle,
      },
      fund,
    },
  });
  return { settle, fund, upstream };
}
function noPaymentHeaders(response: Response) {
  for (const header of [
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "X-Zevium-Wallet-Session",
  ])
    expect(response.headers.has(header)).toBe(false);
}

afterEach(() => {
  __setTestPipelineDeps(null);
  __resetProdDepsCache();
  vi.restoreAllMocks();
});

describe("x402 explicit activation", () => {
  it.each([undefined, "false", "", "1", "TRUE"])(
    "keeps configured production payments off for %s",
    async (flag) => {
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request"));
      const bindings = { ...configured, X402_ENABLED: flag };
      for (const headers of [
        {},
        { "PAYMENT-SIGNATURE": paymentHeader({ id: "proof" }) },
      ]) {
        const response = await call(new Request(target, { headers }), bindings);
        expect(response.status).toBe(402);
        noPaymentHeaders(response);
        expect(await response.json()).toMatchObject({
          reason: "missing_api_key",
          actions: { createKey: expect.any(String) },
        });
      }
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("invalidates cached production deps when activation changes and still needs complete configuration", async () => {
    const on = { ...configured, X402_ENABLED: "true" };
    expect(
      (await call(new Request(target), on)).headers.has("PAYMENT-REQUIRED"),
    ).toBe(true);
    noPaymentHeaders(await call(new Request(target)));
    noPaymentHeaders(
      await call(new Request(target), { ...on, WALLET_SESSION_SECRET: "" }),
    );
    noPaymentHeaders(
      await call(new Request(target), {
        ...on,
        WALLET_SESSION_SECRET: "short",
      }),
    );
    expect(
      (await call(new Request(target), on)).headers.has("PAYMENT-REQUIRED"),
    ).toBe(true);
  });

  it("rejects existing sessions and payment proofs across HTTP and MCP without funding or execution", async () => {
    const f = fixtures();
    const token = await issueWalletSession(
      signingSecret,
      "https://gateway.test",
      "eip155:8453",
      "0x" + "a".repeat(40),
    );
    for (const headers of [
      {},
      { "PAYMENT-SIGNATURE": paymentHeader({ id: "proof" }) },
      { authorization: `Bearer ${token}` },
    ]) {
      const direct = await call(new Request(target, { headers }));
      expect(direct.status).toBe(402);
      noPaymentHeaders(direct);
      const response = await call(
        mcp(
          "tools/call",
          {
            name: "call_api",
            arguments: {
              org: "acme",
              project: "api",
              method: "GET",
              path: "/echo",
            },
          },
          headers,
        ),
      );
      expect(response.status).toBe(200);
      noPaymentHeaders(response);
      const body = await response.text();
      expect(body).toContain("isError");
      expect(body).toContain(
        headers.authorization ? "invalid_api_key" : "missing_api_key",
      );
      expect(body).not.toMatch(
        /paymentRequired|wallet.session|expiresAt|expiry/i,
      );
    }
    const oauth = await call(mcp("tools/list"), {
      ...configured,
      MCP_OAUTH_ISSUER: "https://clerk.oauth.test",
      MCP_OAUTH_RESOURCE: "https://gateway.test/mcp",
    });
    expect(oauth.status).toBe(401);
    expect(oauth.headers.get("WWW-Authenticate")).toContain("Bearer");
    noPaymentHeaders(oauth);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.fund).not.toHaveBeenCalled();
    expect(f.upstream).not.toHaveBeenCalled();
  });

  it("does not advertise machine payments in discovery or MCP tool docs", async () => {
    fixtures();
    for (const request of [
      new Request("https://gateway.test/discovery"),
      mcp("tools/list"),
      mcp("initialize"),
    ]) {
      const response = await call(request);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(
        /x402|wallet.session|payment.required|expiry/i,
      );
    }
  });

  it("blocks proof settlement inside the Durable Object while disabled", async () => {
    const proof = env.WALLET.get(
      env.WALLET.idFromName(`x402-proof:${crypto.randomUUID()}`),
    );
    await runInDurableObject(proof, async (_wallet, state) => {
      await state.storage.put("machine-payment-result", {
        paymentId: "pi_prior",
        transaction: "0x" + "1".repeat(64),
        network: "eip155:8453",
        payer: "0x" + "a".repeat(40),
      });
    });
    expect(await proof.settleMachineProof({})).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
