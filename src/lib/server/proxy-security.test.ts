import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearProxySecurityCacheForTests,
  type DnsLookupFn,
  isHostAllowlisted,
  isLocalOrPrivateHost,
  normalizeProxySecret,
  parseProxyAllowlist,
} from "./proxy-security";

describe("proxy-security", () => {
  beforeEach(() => {
    clearProxySecurityCacheForTests();
  });

  describe("normalizeProxySecret", () => {
    it("returns null for missing or empty values", () => {
      expect(normalizeProxySecret(undefined)).toBeNull();
      expect(normalizeProxySecret("")).toBeNull();
      expect(normalizeProxySecret("   ")).toBeNull();
    });

    it("returns a trimmed secret for valid values", () => {
      expect(normalizeProxySecret("  secret-value  ")).toBe("secret-value");
    });
  });

  describe("allowlist", () => {
    it("parses exact and wildcard entries and rejects non-matches", () => {
      const allowlist = parseProxyAllowlist("api.openai.com, *.example.com\ninternal.example.org");

      expect(isHostAllowlisted("api.openai.com", allowlist)).toBe(true);
      expect(isHostAllowlisted("foo.example.com", allowlist)).toBe(true);
      expect(isHostAllowlisted("example.com", allowlist)).toBe(false);
      expect(isHostAllowlisted("evil.com", allowlist)).toBe(false);
    });
  });

  describe("isLocalOrPrivateHost", () => {
    it("returns true for localhost", async () => {
      await expect(isLocalOrPrivateHost("localhost")).resolves.toBe(true);
    });

    it("returns true for private DNS results", async () => {
      const dnsLookup = vi.fn(() => Promise.resolve([{ address: "10.0.0.42", family: 4 }]));

      await expect(
        isLocalOrPrivateHost("internal.example.com", {
          dnsLookup: dnsLookup as unknown as DnsLookupFn,
          nowMs: () => 1,
          ttlMs: 60_000,
        }),
      ).resolves.toBe(true);
    });

    it("returns false for public DNS results", async () => {
      const dnsLookup = vi.fn(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]));

      await expect(
        isLocalOrPrivateHost("public.example.com", {
          dnsLookup: dnsLookup as unknown as DnsLookupFn,
          nowMs: () => 1,
          ttlMs: 60_000,
        }),
      ).resolves.toBe(false);
    });
  });
});
