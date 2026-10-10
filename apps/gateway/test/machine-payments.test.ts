import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  __setTestPipelineDeps,
  __setTestGrantsFetcher,
  __setTestUsageMutation,
  type Env,
} from "../src/index";
import { FixtureSpecSource } from "../src/spec-source";
import { FixtureCatalogueSource } from "../src/catalogue-source";
import {
  type MachinePaymentDeps,
  paymentHeader,
} from "../src/machine-payments";
import {
  StripeX402Facilitator,
  PaymentRejected,
  PaymentUnavailable,
} from "../src/machine-facilitator";
import { issueWalletSession, verifyWalletSession } from "../src/wallet-session";
import {
  fundingExpiresAt,
  verifyAdmissionProof,
  machineWalletId,
  type MachineGrant,
} from "@zevium/shared";

const secret = "unit-test-session-signing-secret-32-bytes";
let payer = "0x" + "a".repeat(40);
beforeEach(() => {
  payer = "0x" + crypto.randomUUID().replace(/-/g, "").padEnd(40, "0");
});
const network = "eip155:8453";
const url = "https://gateway.test/gateway/acme/api/echo";
const requirements = {
  scheme: "exact" as const,
  network,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
  payTo: "0x" + "b".repeat(40),
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
afterEach(() => {
  __setTestPipelineDeps(null);
  __setTestGrantsFetcher(null);
  __setTestUsageMutation(null);
  vi.restoreAllMocks();
});
function setup(cost = 5000) {
  const used = new Set<string>();
  const settle = vi.fn(async (payload: unknown) => {
    const p = payload as { id?: string };
    if (!p.id) throw new PaymentRejected();
    return {
      paymentId: `pi_${p.id}`,
      payer,
      network,
      transaction: "0x" + (p.id === "two" ? "2" : "1").repeat(64),
    };
  });
  const fund = vi.fn<MachinePaymentDeps["fund"]>(async (payment) => {
    const applied = !used.has(payment.paymentId);
    used.add(payment.paymentId);
    const createdAt = Date.now();
    return {
      walletId: machineWalletId(network, payer),
      sourceRef: `x402:${payment.paymentId}`,
      credits: 10_000,
      createdAt,
      expiresAt: fundingExpiresAt(createdAt),
      applied,
    };
  });
  const specs = new FixtureSpecSource();
  specs.set("acme", "api", {
    spec: JSON.stringify({
      openapi: "3.1.0",
      info: { title: "API", version: "1" },
      servers: [{ url: "https://upstream.test" }],
      paths: {
        "/echo": { get: { "x-zevium-cost": cost } },
        "/free": { get: { "x-zevium-cost": 0 } },
      },
    }),
    specVersionId: "version",
    version: "1",
    projectId: "project",
    organizationId: "publisher",
    clerkOrgId: "org_publisher",
    visibility: "public",
  });
  const upstream = vi.fn<typeof fetch>(async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("payment-signature")).toBe(false);
    return Response.json({ ok: true });
  });
  const clerk = vi.fn(async () => {
    throw new Error("Clerk called on anonymous path");
  });
  __setTestPipelineDeps({
    machinePayments: {
      facilitator: { requirements, settle },
      signingSecret: secret,
      fund,
    },
    keyVerifier: { verify: clerk },
    specSource: specs,
    publicSpecSource: specs,
    catalogueSource: new FixtureCatalogueSource(),
    fetchImpl: upstream,
  });
  const grants = vi.fn(async () => {
    throw new Error("Convex called on session path");
  });
  __setTestGrantsFetcher(grants);
  return { settle, fund, upstream, clerk, grants, specs };
}
async function call(headers: HeadersInit = {}, target = url) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(target, { headers }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("anonymous x402 wallet rail", () => {
  it("shares a durable rate bucket across payer sessions, isolates payers, and binds admission proofs to wallets", async () => {
    const f = setup(1);
    const first = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    expect(first.status).toBe(200);
    const token = first.headers.get("x-zevium-wallet-session")!;
    const walletId = machineWalletId(network, payer);
    const stub = env.WALLET.get(env.WALLET.idFromName(walletId));
    const event = (await stub.getState()).pendingSettlements[0]!;
    const binding = {
      reservationId: event.reservationId,
      consumerClerkOrgId: walletId,
      projectId: "project",
      routeRevision: "version",
    };
    expect(
      await verifyAdmissionProof(
        "test-admission-secret",
        event.usage!.admissionProof!,
        binding,
      ),
    ).toMatchObject({ ...binding, mode: "open" });
    expect(
      await verifyAdmissionProof(
        "test-admission-secret",
        event.usage!.admissionProof!,
        {
          ...binding,
          consumerClerkOrgId: machineWalletId(network, "0x" + "f".repeat(40)),
        },
      ),
    ).toBeNull();

    // Freeze only this bucket's refill clock; exercising HTTP calls uses real timers.
    await runInDurableObject(stub, async (_wallet, state) => {
      state.storage.sql.exec(
        "UPDATE key_rate_buckets SET tokens = 1, updated_at = ? WHERE key_id = ?",
        Date.now() + 60_000,
        walletId,
      );
    });
    const renewed = await issueWalletSession(
      secret,
      "https://gateway.test",
      network,
      payer,
      Date.now() - 1000,
    );
    expect(renewed).not.toBe(token);
    expect(
      (
        await call(
          { authorization: `Bearer ${renewed}` },
          url.replace("echo", "free"),
        )
      ).status,
    ).toBe(200);
    await evictDurableObject(stub);
    for (const credential of [token, renewed]) {
      const blocked = await call({ authorization: `Bearer ${credential}` });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBe("1");
      expect(await blocked.json()).toMatchObject({ error: "key_rate_limited" });
    }
    expect(f.upstream).toHaveBeenCalledTimes(2);
    const balance = (await stub.getState()).balance;
    expect(balance).toBe(9999);
    payer = "0x" + "f".repeat(40);
    expect(
      (await call({ "PAYMENT-SIGNATURE": paymentHeader({ id: "two" }) }))
        .status,
    ).toBe(200);
    expect(f.grants).not.toHaveBeenCalled();
    expect(f.clerk).not.toHaveBeenCalled();
  });
  it("offers V2 + human recovery, pays once, spends to zero, refuses replay and keeps network off subsequent calls", async () => {
    const f = setup();
    const challenge = await call();
    expect(challenge.status).toBe(402);
    expect(
      JSON.parse(atob(challenge.headers.get("PAYMENT-REQUIRED")!)),
    ).toMatchObject({ x402Version: 2, accepts: [requirements] });
    expect(await challenge.json()).toMatchObject({
      actions: { createKey: expect.any(String), topUp: expect.any(String) },
    });
    const first = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    expect(first.status).toBe(200);
    const token = first.headers.get("x-zevium-wallet-session")!;
    expect(token).toMatch(/^zev_ws_/);
    expect(
      JSON.parse(atob(first.headers.get("PAYMENT-RESPONSE")!)),
    ).toMatchObject({ success: true, payer });
    expect((await call({ authorization: `Bearer ${token}` })).status).toBe(200);
    const empty = await call({ authorization: `Bearer ${token}` });
    expect(empty.status).toBe(402);
    expect(empty.headers.has("PAYMENT-REQUIRED")).toBe(true);
    expect(
      (
        await call(
          { authorization: `Bearer ${token}` },
          url.replace("echo", "free"),
        )
      ).status,
    ).toBe(402);
    expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.fund).toHaveBeenCalledTimes(1);
    expect(f.grants).not.toHaveBeenCalled();
    expect(f.clerk).not.toHaveBeenCalled();
    const replay = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    expect(replay.status).toBe(409);
    expect(replay.headers.has("x-zevium-wallet-session")).toBe(false);
    const stub = env.WALLET.get(
      env.WALLET.idFromName(machineWalletId(network, payer)),
    );
    expect((await stub.getState()).balance).toBe(0);
    const events = (await stub.getState()).pendingSettlements;
    expect(events.map((e) => e.usage?.machineFunding?.lots)).toEqual([
      [{ sourceRef: "x402:pi_one", credits: 5000 }],
      [{ sourceRef: "x402:pi_one", credits: 5000 }],
    ]);
    __setTestUsageMutation(async (_name, { events: records }) => {
      expect(records.map((record) => record.machineFunding?.lots)).toEqual([
        [{ sourceRef: "x402:pi_one", credits: 5000 }],
        [{ sourceRef: "x402:pi_one", credits: 5000 }],
      ]);
      return {
        results: records.map((record) => ({
          refId: record.settleRefId,
          status: "applied" as const,
        })),
        wallet: {
          clerkOrgId: machineWalletId(network, payer),
          balance: 0,
          sequence: 3,
        },
      };
    });
    expect(await stub.flushToConvex()).toMatchObject({
      acked: 2,
      remaining: 0,
    });
    expect((await stub.getState()).balance).toBe(0);
    expect(
      (await call({ "PAYMENT-SIGNATURE": paymentHeader({ id: "two" }) }))
        .status,
    ).toBe(200);
  });
  it("never grants or executes for malformed/rejected proofs; private projects stay private", async () => {
    const f = setup();
    expect((await call({ "PAYMENT-SIGNATURE": "bad" })).status).toBe(402);
    expect(f.fund).not.toHaveBeenCalled();
    expect(f.upstream).not.toHaveBeenCalled();
    const first = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    const published = await f.specs.getPublishedSpec("acme", "api");
    f.specs.set("acme", "api", { ...published!, visibility: "private" });
    expect(
      (
        await call({
          authorization: `Bearer ${first.headers.get("x-zevium-wallet-session")}`,
        })
      ).status,
    ).toBe(404);
  });
  it("reserves oldest lots, preserves holds across expiry, refunds only unexpired availability, persists lot state", async () => {
    const walletId = machineWalletId(network, "0x" + "c".repeat(40));
    const stub = env.WALLET.get(env.WALLET.idFromName(walletId));
    const now = Date.now();
    const lot = (id: string, createdAt: number): MachineGrant => ({
      walletId,
      sourceRef: `x402:pi_${id}`,
      credits: 10_000,
      createdAt,
      expiresAt: fundingExpiresAt(createdAt),
      applied: true,
    });
    const first = lot("old", now - 1000);
    const second = lot("new", now);
    await stub.grantMachineLot(first);
    await stub.grantMachineLot(second);
    expect(
      (
        await stub.reserve("hold", 6000, {
          keyId: walletId,
          clerkOrgId: walletId,
          nowMs: first.expiresAt - 1,
        })
      ).status,
    ).toBe("reserved");
    expect((await stub.getState()).inFlight.hold?.machineFunding?.lots).toEqual(
      [{ sourceRef: first.sourceRef, credits: 6000 }],
    );
    expect(
      (
        await stub.reserve("later", 10_000, {
          keyId: walletId,
          clerkOrgId: walletId,
          nowMs: first.expiresAt,
        })
      ).status,
    ).toBe("reserved");
    expect(
      (await stub.getState()).inFlight.later?.machineFunding?.lots,
    ).toEqual([{ sourceRef: second.sourceRef, credits: 10_000 }]);
    expect(
      await stub.reserve("oversize-token", 6000, {
        keyId: walletId,
        clerkOrgId: walletId,
        nowMs: first.expiresAt,
        tokenPricing: true,
      }),
    ).toMatchObject({ status: "rejected", reason: "weight_exceeds_budget" });
    await stub.settle("hold");
    await stub.refund("later");
    expect(
      (
        await stub.reserve("expired", 1, {
          keyId: walletId,
          clerkOrgId: walletId,
          nowMs: second.expiresAt,
        })
      ).status,
    ).toBe("insufficient");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ data: string }>(
            "SELECT data FROM machine_lots ORDER BY position",
          )
          .toArray()
          .map((row) => JSON.parse(row.data).remaining),
      ).toEqual([4000, 10_000]);
    });
  });
  it("settles actual token costs from reserved lots and records free/refunded usage", async () => {
    const f = setup(0);
    const first = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    expect(first.status).toBe(200);
    const token = first.headers.get("x-zevium-wallet-session")!;
    const walletId = machineWalletId(network, payer);
    const stub = env.WALLET.get(env.WALLET.idFromName(walletId));
    expect(
      (await stub.getState()).pendingSettlements[0]?.usage?.machineFunding
        ?.lots,
    ).toEqual([]);
    const published = (await f.specs.getPublishedSpec("acme", "api"))!;
    const spec = JSON.parse(published.spec);
    spec.paths["/echo"] = {
      post: {
        "x-zevium-cost": {
          per: "token",
          input: 1000000,
          output: 1000000,
          maxPerCall: 1000,
        },
      },
    };
    f.specs.set("acme", "api", {
      ...published,
      spec: JSON.stringify(spec),
      specVersionId: "token-version",
    });
    async function tokenCall() {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ messages: [], max_tokens: 100 }),
        }),
        env as unknown as Env,
        ctx,
      );
      await response.text();
      await waitOnExecutionContext(ctx);
      return response;
    }
    f.upstream.mockImplementation(async () =>
      Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20 } }),
    );
    const paid = await tokenCall();
    expect(paid.status).toBe(200);
    expect(Number(paid.headers.get("x-zevium-hold"))).toBeGreaterThan(30);
    let state = await stub.getState();
    expect(state.balance).toBe(9970);
    expect(state.available).toBe(9970);
    expect(state.pendingSettlements.at(-1)).toMatchObject({
      cost: 30,
      usage: {
        machineFunding: { lots: [{ sourceRef: "x402:pi_one", credits: 30 }] },
      },
    });
    f.upstream.mockImplementation(async () => Response.json({ choices: [] }));
    expect((await tokenCall()).status).toBe(200);
    state = await stub.getState();
    expect(state.available).toBe(9970);
    expect(state.pendingSettlements.at(-1)).toMatchObject({
      cost: 0,
      usage: { machineFunding: { lots: [] } },
    });
    f.upstream.mockImplementation(
      async () => new Response("upstream failed", { status: 500 }),
    );
    expect((await tokenCall()).status).toBe(500);
    state = await stub.getState();
    expect(state.available).toBe(9970);
    expect(state.pendingSettlements.at(-1)).toMatchObject({
      cost: 0,
      usage: { machineFunding: { lots: [] } },
    });
    await runInDurableObject(stub, async (_instance, storage) => {
      const row = storage.storage.sql
        .exec<{ data: string }>("SELECT data FROM machine_lots")
        .one();
      expect(JSON.parse(row.data).remaining).toBe(9970);
    });
  });
  it("uses a wallet session for MCP call_api and returns a payable offer without credentials", async () => {
    const f = setup(2500);
    const first = await call({
      "PAYMENT-SIGNATURE": paymentHeader({ id: "one" }),
    });
    const token = first.headers.get("x-zevium-wallet-session")!;
    async function mcp(session?: string, oauth = false) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request("https://gateway.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(session ? { authorization: `Bearer ${session}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "call_api",
              arguments: {
                org: "acme",
                project: "api",
                method: "GET",
                path: "/echo",
              },
            },
          }),
        }),
        {
          ...env,
          ...(oauth
            ? {
                MCP_OAUTH_ISSUER: "https://clerk.oauth.test",
                MCP_OAUTH_RESOURCE: "https://gateway.test/mcp",
              }
            : {}),
        } as unknown as Env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
    }
    const result = await mcp(token);
    expect(result.result.isError).not.toBe(true);
    const withOAuth = await mcp(token, true);
    expect(withOAuth.result.isError).not.toBe(true);
    expect(f.clerk).not.toHaveBeenCalled();
    expect(f.grants).not.toHaveBeenCalled();
    const unpaid = await mcp();
    expect(unpaid.result.isError).toBe(true);
    expect(JSON.parse(unpaid.result.content[0]!.text)).toMatchObject({
      status: 402,
      paymentRequired: expect.any(String),
    });
  });
  it("binds session signature, audience, scope and expiry", async () => {
    const now = Date.now();
    const token = await issueWalletSession(
      secret,
      "https://gateway.test",
      network,
      payer,
      now,
    );
    expect(
      await verifyWalletSession(token, secret, "https://gateway.test", now),
    ).toMatchObject({ orgId: machineWalletId(network, payer) });
    expect(
      await verifyWalletSession(token, secret, "https://evil.test", now),
    ).toBeNull();
    expect(
      await verifyWalletSession(
        token,
        secret,
        "https://gateway.test",
        now + 86400_000,
      ),
    ).toBeNull();
    expect(
      await verifyWalletSession(
        token.slice(0, -2) + "xx",
        secret,
        "https://gateway.test",
        now,
      ),
    ).toBeNull();
  });
});

describe("Stripe x402 facilitator HTTP contract", () => {
  it("requires matching /verify, /settle AND succeeded Stripe receipt, with stable payment idempotency", async () => {
    const requests: Request[] = [];
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      if (req.url.endsWith("/verify"))
        return Response.json({ isValid: true, payer });
      if (req.url.endsWith("/settle"))
        return Response.json({
          success: true,
          payer,
          network,
          transaction: "0x" + "1".repeat(64),
        });
      return Response.json({
        id: "pi_contract",
        status: "succeeded",
        amount: 100,
        amount_received: 100,
        currency: "usd",
        livemode: false,
      });
    });
    const adapter = new StripeX402Facilitator({
      depositAddress: requirements.payTo,
      facilitatorUrl: "https://facilitator.test",
      facilitatorToken: "fixture",
      stripeKey: "sk_test_fixture",
      fetchImpl: mock,
    });
    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: { signature: "fixture" },
    };
    expect(await adapter.settle(payload)).toMatchObject({
      paymentId: "pi_contract",
      payer,
    });
    expect(await requests[0]!.json()).toMatchObject({
      x402Version: 2,
      paymentRequirements: requirements,
      paymentPayload: payload,
    });
    expect(requests[2]!.headers.get("Idempotency-Key")).toBe(
      `x402:${network}:0x${"1".repeat(64)}`,
    );
    const form = await requests[2]!.text();
    expect(
      new URLSearchParams(form).get("payment_method_options[crypto][mode]"),
    ).toBe("transaction_verification");
    await expect(
      adapter.settle({
        ...payload,
        accepted: { ...requirements, amount: "1" },
      }),
    ).rejects.toBeInstanceOf(PaymentRejected);
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it("reuses a durable settlement receipt after a Stripe outage", async () => {
    let receipt: Omit<
      import("../src/machine-facilitator").VerifiedPayment,
      "paymentId"
    > | null = null;
    let stripeCalls = 0;
    const mock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/verify"))
        return Response.json({ isValid: true, payer });
      if (String(input).endsWith("/settle"))
        return Response.json({
          success: true,
          payer,
          network,
          transaction: "0x" + "1".repeat(64),
        });
      stripeCalls++;
      return stripeCalls === 1
        ? new Response(null, { status: 503 })
        : Response.json({
            id: "pi_retry",
            status: "succeeded",
            amount: 100,
            amount_received: 100,
            currency: "usd",
            livemode: false,
          });
    });
    const options = {
      depositAddress: requirements.payTo,
      facilitatorUrl: "https://facilitator.test",
      facilitatorToken: "fixture",
      stripeKey: "sk_test_fixture",
      fetchImpl: mock,
      settlementReceipt: {
        load: async () => receipt,
        save: async (value: NonNullable<typeof receipt>) => {
          receipt = value;
        },
      },
    };
    const payload = { x402Version: 2, accepted: requirements };
    await expect(
      new StripeX402Facilitator(options).settle(payload),
    ).rejects.toBeInstanceOf(PaymentUnavailable);
    expect(
      await new StripeX402Facilitator(options).settle(payload),
    ).toMatchObject({ paymentId: "pi_retry" });
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it("retrieves an intent when Stripe replays its original processing response", async () => {
    const mock = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input);
      if (target.endsWith("/verify"))
        return Response.json({ isValid: true, payer });
      if (target.endsWith("/settle"))
        return Response.json({
          success: true,
          payer,
          network,
          transaction: "0x" + "1".repeat(64),
        });
      const succeeded = target.endsWith("/pi_async");
      if (succeeded) expect(init?.method).toBeUndefined();
      return Response.json({
        id: "pi_async",
        status: succeeded ? "succeeded" : "processing",
        amount: 100,
        amount_received: succeeded ? 100 : 0,
        currency: "usd",
        livemode: false,
      });
    });
    const adapter = new StripeX402Facilitator({
      depositAddress: requirements.payTo,
      facilitatorUrl: "https://facilitator.test",
      facilitatorToken: "fixture",
      stripeKey: "sk_test_fixture",
      fetchImpl: mock,
    });
    expect(
      await adapter.settle({ x402Version: 2, accepted: requirements }),
    ).toMatchObject({ paymentId: "pi_async" });
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it("does not fund pending Stripe payments or a substituted payer", async () => {
    for (const badPayer of [false, true]) {
      const mock = vi.fn<typeof fetch>(async (input) => {
        const path = String(input);
        if (path.endsWith("/verify"))
          return Response.json({ isValid: true, payer });
        if (path.endsWith("/settle"))
          return Response.json({
            success: true,
            payer: badPayer ? requirements.payTo : payer,
            network,
            transaction: "0x" + "1".repeat(64),
          });
        return Response.json({
          id: "pi_pending",
          status: "processing",
          amount: 100,
          amount_received: 0,
          currency: "usd",
          livemode: false,
        });
      });
      const adapter = new StripeX402Facilitator({
        depositAddress: requirements.payTo,
        facilitatorUrl: "https://facilitator.test",
        facilitatorToken: "fixture",
        stripeKey: "sk_test_fixture",
        fetchImpl: mock,
      });
      await expect(
        adapter.settle({ x402Version: 2, accepted: requirements }),
      ).rejects.toBeInstanceOf(badPayer ? PaymentRejected : PaymentUnavailable);
      expect(mock).toHaveBeenCalledTimes(badPayer ? 2 : 4);
    }
  });
});
