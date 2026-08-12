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
    {
      ...env,
      CONVEX_URL: "https://proof.convex.cloud",
      CONVEX_SITE_URL: "https://proof.convex.site",
      GATEWAY_INTERNAL_SECRET: "x".repeat(32),
      CLERK_SECRET_KEY: "sk_test_proof_gateway_fixture",
      ZEVIUM_GIT_SHA: "a".repeat(40),
      ZEVIUM_GATEWAY_DEPLOYMENT_ID: "staging-gateway-proof-123",
      ZEVIUM_DEPLOYED_AT: "2026-08-12T00:00:00.000Z",
      ZEVIUM_DEPLOYMENT_MODE: "staging",
      ...overrides,
    } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("production health configuration matrix", () => {
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
    "ZEVIUM_GIT_SHA",
    "ZEVIUM_GATEWAY_DEPLOYMENT_ID",
    "ZEVIUM_DEPLOYED_AT",
    "ZEVIUM_DEPLOYMENT_MODE",
  ] as const) {
    it(`fails closed when ${missing} is absent in production`, async () => {
      expect(
        (await health({ GATEWAY_TEST_MODE: undefined, [missing]: undefined }))
          .status,
      ).toBe(503);
    });
  }

  for (const [label, overrides] of [
    ["mode", { ZEVIUM_DEPLOYMENT_MODE: "development" }],
    ["sha", { ZEVIUM_GIT_SHA: "not-a-sha" }],
    ["id", { ZEVIUM_GATEWAY_DEPLOYMENT_ID: "short" }],
    ["timestamp", { ZEVIUM_DEPLOYED_AT: "2026-08-12" }],
  ] satisfies Array<[string, Partial<Env>]>) {
    it(`fails closed for invalid deployment ${label}`, async () => {
      expect(
        (await health({ GATEWAY_TEST_MODE: undefined, ...overrides })).status,
      ).toBe(503);
    });
  }

  it("returns exact immutable deployment evidence", async () => {
    const response = await health({ GATEWAY_TEST_MODE: undefined });
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "zevium-gateway",
      deployment: {
        schemaVersion: 1,
        service: "gateway",
        mode: "staging",
        gitSha: "a".repeat(40),
        deploymentId: "staging-gateway-proof-123",
        deployedAt: "2026-08-12T00:00:00.000Z",
      },
    });
  });
});
