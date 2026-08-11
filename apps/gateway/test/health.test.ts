import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

async function health(overrides: Partial<Env>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://gateway.test/health"),
    { ...env, ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("production health configuration matrix", () => {
  it("exposes immutable release and contract identities", async () => {
    const response = await health({
      GATEWAY_TEST_MODE: "1",
      ZEVIUM_RELEASE: "a".repeat(40),
    });

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "zevium-gateway",
      release: "a".repeat(40),
      contract: 1,
    });
  });

  it("accepts explicit test mode", async () => {
    expect(
      (
        await health({
          GATEWAY_TEST_MODE: "1",
          CONVEX_URL: undefined,
          CONVEX_SITE_URL: undefined,
          GATEWAY_INTERNAL_SECRET: undefined,
          CLERK_SECRET_KEY: undefined,
        })
      ).status,
    ).toBe(200);
  });

  for (const missing of [
    "CONVEX_URL",
    "CONVEX_SITE_URL",
    "GATEWAY_INTERNAL_SECRET",
    "CLERK_SECRET_KEY",
  ] as const) {
    it(`fails closed when ${missing} is absent in production`, async () => {
      expect(
        (await health({ GATEWAY_TEST_MODE: undefined, [missing]: undefined }))
          .status,
      ).toBe(503);
    });
  }
});
