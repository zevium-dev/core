import { describe, expect, it } from "vitest";

import {
  anonymousSearchKey,
  searchNetwork,
  trustedClientIp,
} from "./edge/search-identity";

describe("search identity", () => {
  it("keys IPv4 per address and IPv6 per /64", () => {
    expect(searchNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(searchNetwork("2001:db8:1:2:3:4:5:6")).toBe(
      "2001:0db8:0001:0002/64",
    );
    expect(searchNetwork("2001:db8:1:2::9")).toBe("2001:0db8:0001:0002/64");
    expect(searchNetwork("2001:db8::1")).toBe("2001:0db8:0000:0000/64");
  });

  it("derives one opaque key per secret and network", async () => {
    const a = await anonymousSearchKey("s", "2001:db8:1:2::1");
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await anonymousSearchKey("s", "2001:db8:1:2::ffff")).toBe(a);
    expect(await anonymousSearchKey("t", "2001:db8:1:2::1")).not.toBe(a);
  });

  it("trusts the client IP only with Cloudflare connection metadata", () => {
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    expect(trustedClientIp(new Request("https://x.test", { headers }))).toBe(
      null,
    );
    const viaCf = Object.assign(new Request("https://x.test", { headers }), {
      cf: {},
    });
    expect(trustedClientIp(viaCf)).toBe("203.0.113.7");
  });
});
