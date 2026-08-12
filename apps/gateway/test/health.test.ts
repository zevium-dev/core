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
      ZEVIUM_RELEASE: "a".repeat(40),
      CF_VERSION_METADATA: {
        id: "123e4567-e89b-42d3-a456-426614174000",
        tag: `staging-${"a".repeat(40)}`,
        timestamp: "2026-08-12T00:00:00.000Z",
      },
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
    "ZEVIUM_RELEASE",
    "CF_VERSION_METADATA",
  ] as const) {
    it(`fails closed when ${missing} is absent in production`, async () => {
      expect(
        (await health({ GATEWAY_TEST_MODE: undefined, [missing]: undefined }))
          .status,
      ).toBe(503);
    });
  }

  for (const [label, overrides] of [
    ["sha", { ZEVIUM_RELEASE: "not-a-sha" }],
    [
      "id",
      {
        CF_VERSION_METADATA: {
          id: "short",
          tag: `staging-${"a".repeat(40)}`,
          timestamp: "2026-08-12T00:00:00.000Z",
        },
      },
    ],
    [
      "tag",
      {
        CF_VERSION_METADATA: {
          id: "123e4567-e89b-42d3-a456-426614174000",
          tag: `production-${"b".repeat(40)}`,
          timestamp: "2026-08-12T00:00:00.000Z",
        },
      },
    ],
    [
      "timestamp",
      {
        CF_VERSION_METADATA: {
          id: "123e4567-e89b-42d3-a456-426614174000",
          tag: `staging-${"a".repeat(40)}`,
          timestamp: "2026-08-12",
        },
      },
    ],
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
        schema: "zevium.cloudflare-runtime/v1",
        service: "gateway",
        gitSha: "a".repeat(40),
        versionId: "123e4567-e89b-42d3-a456-426614174000",
        versionTag: `staging-${"a".repeat(40)}`,
        deployedAt: "2026-08-12T00:00:00.000Z",
      },
    });
  });
});
