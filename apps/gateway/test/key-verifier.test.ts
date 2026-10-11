import { describe, expect, it } from "vitest";
import { extractApiKey } from "../src/key-verifier";
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
