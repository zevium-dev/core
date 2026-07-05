import { describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("~/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => mockQuery()),
        })),
      })),
    })),
  },
  schema: {
    proxyHost: { host: "host", unitCost: "unit_cost", userId: "user_id" },
  },
}));

import { getProxyHostConfig, normalizeHost } from "./proxy-cost";

describe("proxy-cost", () => {
  describe("normalizeHost", () => {
    it("lowercases and trims", () => {
      expect(normalizeHost("  Api.OpenAI.Com  ")).toBe("api.openai.com");
    });

    it("throws on empty input", () => {
      expect(() => normalizeHost("")).toThrow("Empty host header");
    });

    it("rejects non-HTTPS protocol", () => {
      expect(() => normalizeHost("http://api.openai.com")).toThrow("Only HTTPS hosts are allowed");
    });
  });

  describe("getProxyHostConfig", () => {
    it("returns host config when row exists", async () => {
      mockQuery.mockResolvedValueOnce([{ host: "api.openai.com", unitCost: 3 }]);
      const result = await getProxyHostConfig("user_123", "api.openai.com");
      expect(result).toEqual({ host: "api.openai.com", unitCost: 3 });
    });

    it("returns null when host not configured for user", async () => {
      mockQuery.mockResolvedValueOnce([]);
      const result = await getProxyHostConfig("user_123", "evil.com");
      expect(result).toBeNull();
    });
  });
});
