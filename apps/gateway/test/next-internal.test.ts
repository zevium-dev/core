import { expect, it, vi } from "vitest";
import { readWalletFailure } from "../src/next/wake";
import type { NextEnv } from "../src/next/snapshots";

it("requires the internal secret and deployment binding before exposing exact failure evidence", async () => {
  const failureEvidence = vi.fn().mockResolvedValue({
    eventJson: "{}",
    expectedFingerprint: "a".repeat(64),
    expectedWatermark: 0,
    reason: "rejected",
  });
  const get = vi.fn(() => ({ failureEvidence }));
  const env: NextEnv = {
    NEXT_DEPLOYMENT_ID: "next-fixture",
    GATEWAY_INTERNAL_SECRET: "test-only-internal-secret-never-production",
    NEXT_WALLET: {
      get,
      idFromName: vi.fn(),
    } as unknown as NextEnv["NEXT_WALLET"],
  };
  const request = (secret: string, deploymentId = "next-fixture") =>
    new Request("https://gateway.test/internal/next-failure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({
        clerkOrgId: "org",
        deploymentId,
        settleRefId: "settle:one",
      }),
    });
  expect((await readWalletFailure(request("wrong"), env)).status).toBe(401);
  expect(
    (
      await readWalletFailure(
        request("test-only-internal-secret-never-production", "foreign"),
        env,
      )
    ).status,
  ).toBe(503);
  expect(get).not.toHaveBeenCalled();
  const response = await readWalletFailure(
    request("test-only-internal-secret-never-production"),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(failureEvidence).toHaveBeenCalledExactlyOnceWith("settle:one");
  failureEvidence.mockResolvedValue(null);
  expect(
    (
      await readWalletFailure(
        request("test-only-internal-secret-never-production"),
        env,
      )
    ).status,
  ).toBe(404);
});
