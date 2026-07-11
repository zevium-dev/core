import { describe, expect, it, vi } from "vitest";
import {
  ClerkKeyVerifier,
  extractApiKey,
  parseClerkVerifyResponse,
} from "../src/key-verifier";

describe("extractApiKey", () => {
  it("reads Bearer zev_ token", () => {
    const req = new Request("https://x.test", {
      headers: { authorization: "Bearer zev_abc" },
    });
    expect(extractApiKey(req)).toBe("zev_abc");
  });

  it("reads x-api-key", () => {
    const req = new Request("https://x.test", {
      headers: { "x-api-key": "zev_xyz" },
    });
    expect(extractApiKey(req)).toBe("zev_xyz");
  });

  it("rejects non-zev keys", () => {
    const req = new Request("https://x.test", {
      headers: { authorization: "Bearer sk_live_nope" },
    });
    expect(extractApiKey(req)).toBeNull();
  });
});

describe("parseClerkVerifyResponse", () => {
  it("maps subject + id + scopes", () => {
    expect(
      parseClerkVerifyResponse({
        subject: "org_123",
        id: "ak_1",
        scopes: ["read", "write"],
      }),
    ).toEqual({
      orgId: "org_123",
      keyId: "ak_1",
      scopes: ["read", "write"],
    });
  });

  it("rejects revoked", () => {
    expect(
      parseClerkVerifyResponse({
        subject: "org_123",
        id: "ak_1",
        revoked: true,
      }),
    ).toBeNull();
  });
});

describe("ClerkKeyVerifier", () => {
  it("calls Clerk once then serves memory cache", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ subject: "org_1", id: "ak_9", scopes: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    let now = 1_000_000;
    const verifier = new ClerkKeyVerifier({
      secretKey: "sk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      useCacheApi: false,
    });

    const a = await verifier.verify("zev_secret");
    const b = await verifier.verify("zev_secret");
    expect(a).toEqual({ orgId: "org_1", keyId: "ak_9", scopes: [] });
    expect(b).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After TTL, re-fetch
    now += 61_000;
    const c = await verifier.verify("zev_secret");
    expect(c?.keyId).toBe("ak_9");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null on non-ok Clerk response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 401 }),
    );
    const verifier = new ClerkKeyVerifier({
      secretKey: "sk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      useCacheApi: false,
    });
    expect(await verifier.verify("zev_bad")).toBeNull();
  });
});
