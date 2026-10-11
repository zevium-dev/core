import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it } from "vitest";
import worker, { type Env } from "../src/index";
it("retires direct grants and v1 sync, and refuses x402 without dispatch", async () => {
  for (const path of ["/internal/grant", "/internal/sync", "/machine-fund"]) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://gateway.test${path}`, { method: "POST" }),
      env as Env,
      ctx,
    );
    expect(response.status).toBe(404);
    await waitOnExecutionContext(ctx);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://gateway.test/gateway/house/demo/echo", {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": "retired-proof" },
    }),
    { ...env, X402_ENABLED: "true" } as Env,
    ctx,
  );
  expect(response.status).toBe(402);
  expect(response.headers.has("PAYMENT-REQUIRED")).toBe(false);
  expect(await response.json()).toMatchObject({ reason: "missing_api_key" });
  await waitOnExecutionContext(ctx);
});
