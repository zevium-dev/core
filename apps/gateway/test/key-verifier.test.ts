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

  it("reads Bearer ak_ token (Clerk default)", () => {
    const req = new Request("https://x.test", {
      headers: { authorization: "Bearer ak_live_clerk_secret" },
    });
    expect(extractApiKey(req)).toBe("ak_live_clerk_secret");
  });

  it("reads x-api-key", () => {
    const req = new Request("https://x.test", {
      headers: { "x-api-key": "zev_xyz" },
    });
    expect(extractApiKey(req)).toBe("zev_xyz");
  });

  it("reads x-api-key with ak_ prefix", () => {
    const req = new Request("https://x.test", {
      headers: { "x-api-key": "ak_xyz" },
    });
    expect(extractApiKey(req)).toBe("ak_xyz");
  });

  it("rejects non-ak/zev keys", () => {
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

  it("prefers claims.org_id over user subject", () => {
    expect(
      parseClerkVerifyResponse({
        subject: "user_abc",
        id: "ak_2",
        claims: { org_id: "org_claimed" },
        scopes: [],
      }),
    ).toEqual({
      orgId: "org_claimed",
      keyId: "ak_2",
      scopes: [],
    });
  });

  it("uses org subject when claims absent", () => {
    expect(
      parseClerkVerifyResponse({
        subject: "org_direct",
        id: "ak_3",
        claims: null,
      }),
    ).toEqual({
      orgId: "org_direct",
      keyId: "ak_3",
      scopes: [],
    });
  });

  it("falls back to user subject without claims (legacy)", () => {
    expect(
      parseClerkVerifyResponse({
        subject: "user_legacy",
        id: "ak_4",
      }),
    ).toEqual({
      orgId: "user_legacy",
      keyId: "ak_4",
      scopes: [],
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
    const fetchImpl = vi.fn(
      async () =>
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

    const a = await verifier.verify("ak_secret");
    const b = await verifier.verify("ak_secret");
    expect(a).toEqual({ orgId: "org_1", keyId: "ak_9", scopes: [] });
    expect(b).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After TTL, re-fetch
    now += 61_000;
    const c = await verifier.verify("ak_secret");
    expect(c?.keyId).toBe("ak_9");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null on non-ok Clerk response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const verifier = new ClerkKeyVerifier({
      secretKey: "sk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      useCacheApi: false,
    });
    expect(await verifier.verify("ak_bad")).toBeNull();
  });

  it("marks network failure and 5xx as unavailable and never caches them", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return new Response("clerk down", { status: 502 });
    });
    const verifier = new ClerkKeyVerifier({
      secretKey: "sk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      useCacheApi: false,
    });

    const first = await verifier.verifyWithStatus("ak_flaky");
    expect(first.status).toBe("unavailable");
    // Outage must not poison the negative cache: immediate retry re-fetches.
    const second = await verifier.verifyWithStatus("ak_flaky");
    expect(second.status).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches definitive invalid verdicts within the TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const verifier = new ClerkKeyVerifier({
      secretKey: "sk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      useCacheApi: false,
    });

    expect((await verifier.verifyWithStatus("ak_dead")).status).toBe("invalid");
    expect((await verifier.verifyWithStatus("ak_dead")).status).toBe("invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 61_000;
    await verifier.verifyWithStatus("ak_dead");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
