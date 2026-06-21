import { describe, expect, it, vi } from "vitest";

vi.mock("~/env/server", () => ({
  serverEnv: {
    PROXY_HOST_UNIT_COSTS: { "api.openai.com": 3, "api.anthropic.com": 2 },
    POLAR_ACCESS_TOKEN: "test",
    POLAR_METER_ID: "mtr_test",
    POLAR_ORGANIZATION_ID: "org_test",
    POLAR_PRODUCT_ID_CREDITS: "prd_test",
    POLAR_SERVER: "sandbox",
    POLAR_WEBHOOK_SECRET: "test",
    PROXY_PUBLIC_HOST: "localhost:5173",
    PROXY_REQUEST_TIMEOUT_MS: 30000,
    PROXY_ALLOWED_HOSTS: "api.openai.com",
    PROXY_UPSTREAM_SECRET: "test",
    LIBSQL_URL: "libsql://test.turso.io",
    LIBSQL_SECRET: "test",
  },
}));

import { getHostCost, normalizeHost } from "./proxy-cost";

describe("proxy-cost", () => {
  describe("normalizeHost", () => {
    it("lowercases and trims", () => {
      expect(normalizeHost("  Api.OpenAI.Com  ")).toBe("api.openai.com");
    });

    it("throws on empty input", () => {
      expect(() => normalizeHost("")).toThrow("Empty host header");
    });
  });

  describe("getHostCost", () => {
    it("returns correct cost for priced host", () => {
      expect(getHostCost("api.openai.com")).toBe(3);
      expect(getHostCost("api.anthropic.com")).toBe(2);
    });

    it("throws for unpriced host", () => {
      expect(() => getHostCost("this-host-does-not-exist.example")).toThrow();
    });
  });
});
