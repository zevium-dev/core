import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
  pinnedLookupResult,
  probePublicHttps,
  resolveSafeHttpsUrl,
} from "./qualityProbeAction";

describe("credential-free upstream SSRF guard", () => {
  it("allows public unicast and blocks private, metadata, benchmark, and documentation IPv4", () => {
    expect(isPublicIpv4("8.8.8.8")).toBe(true);
    for (const address of [
      "0.0.0.0",
      "10.0.0.8",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "198.18.0.1",
      "192.0.2.1",
      "224.0.0.1",
    ]) {
      expect(isPublicIpv4(address), address).toBe(false);
    }
  });

  it("only allows global IPv6 unicast and blocks mapped/private/link-local/documentation", () => {
    expect(isPublicIpv6("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIpv6("2001:4860:4860::8888")).toBe(true);
    for (const address of [
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "2002::1",
      "3fff::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects unsafe schemes, URL credentials, ports, local names, and mixed DNS answers", async () => {
    const publicResolver = async () => [
      { address: "93.184.216.34", family: 4 as const },
    ];
    await expect(
      resolveSafeHttpsUrl("http://example.com", publicResolver),
    ).rejects.toThrow("HTTPS");
    await expect(
      resolveSafeHttpsUrl("https://user:pass@example.com", publicResolver),
    ).rejects.toThrow("credentials");
    await expect(
      resolveSafeHttpsUrl("https://example.com:444", publicResolver),
    ).rejects.toThrow("port 443");
    await expect(
      resolveSafeHttpsUrl("https://localhost", publicResolver),
    ).rejects.toThrow("internal");
    await expect(
      resolveSafeHttpsUrl("https://localhost.", publicResolver),
    ).rejects.toThrow("internal");
    await expect(
      resolveSafeHttpsUrl("https://service.local.", publicResolver),
    ).rejects.toThrow("internal");
    await expect(
      resolveSafeHttpsUrl("https://2130706433", publicResolver),
    ).rejects.toThrow("non-public");
    await expect(
      resolveSafeHttpsUrl("https://0x7f000001", publicResolver),
    ).rejects.toThrow("non-public");
    await expect(
      resolveSafeHttpsUrl("https://example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("mixed");
  });

  it("returns vetted addresses for socket pinning, preventing second-lookup rebinding", async () => {
    const result = await resolveSafeHttpsUrl(
      "https://example.com/path",
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    expect(result.url.hostname).toBe("example.com");
    expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(pinnedLookupResult(result.addresses[0]!, true)).toEqual({
      all: true,
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
    expect(pinnedLookupResult(result.addresses[0]!, false)).toEqual({
      all: false,
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("pins vetted DNS and revalidates every redirect before another socket", async () => {
    const requested: Array<{ host: string; address: string }> = [];
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 as const },
    ];
    const result = await probePublicHttps("https://example.com/start", {
      resolver,
      requestHead: async (url, pinned) => {
        requested.push({ host: url.hostname, address: pinned.address });
        return { statusCode: 302, location: "https://127.0.0.1/admin" };
      },
    });
    expect(result).toMatchObject({ outcome: "blocked_target" });
    expect(requested).toEqual([
      { host: "example.com", address: "93.184.216.34" },
    ]);
  });

  it("bounds redirects and DNS time across the whole probe", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 as const },
    ];
    let requests = 0;
    const redirected = await probePublicHttps("https://example.com", {
      resolver,
      requestHead: async () => {
        requests += 1;
        return { statusCode: 302, location: `/hop-${requests}` };
      },
    });
    expect(redirected).toMatchObject({
      outcome: "network_error",
      message: "Upstream redirected too many times",
    });
    expect(requests).toBe(3);

    const timedOut = await probePublicHttps("https://example.com", {
      resolver: async () => await new Promise<never>(() => undefined),
      requestHead: async () => ({ statusCode: 204 }),
      timeoutMs: 5,
    });
    expect(timedOut).toMatchObject({ outcome: "timeout" });
  });

  it("classifies HTTP and TLS outcomes without leaking transport errors", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 as const },
    ];
    const http = await probePublicHttps("https://example.com", {
      resolver,
      requestHead: async () => ({ statusCode: 401 }),
    });
    expect(http).toMatchObject({
      outcome: "http_error",
      statusCode: 401,
      finalOrigin: "https://example.com",
    });
    const invalidHttp = await probePublicHttps("https://example.com", {
      resolver,
      requestHead: async () => ({ statusCode: 0 }),
    });
    expect(invalidHttp).toMatchObject({
      outcome: "network_error",
      message: "Upstream returned an invalid HTTP response.",
    });

    const tls = await probePublicHttps("https://example.com", {
      resolver,
      requestHead: async () => {
        throw Object.assign(new Error("private certificate path"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        });
      },
    });
    expect(tls).toEqual(
      expect.objectContaining({
        outcome: "tls_error",
        message:
          "Upstream TLS handshake failed. Check certificate and hostname.",
      }),
    );
    expect(tls.message).not.toContain("private certificate path");
  });
});
