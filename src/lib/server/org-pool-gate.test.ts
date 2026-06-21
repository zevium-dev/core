import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockIncrby = vi.fn();
vi.mock("~/lib/server/kv", () => ({
  kv: { get: mockGet, incrby: mockIncrby, set: mockSet },
}));

describe("org-pool-gate", () => {
  let gate: typeof import("./org-pool-gate");

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    gate = await import("./org-pool-gate");
  });

  const ORG = "org_abc123";
  const COST = 5;
  const CREDITED = 100;
  const KEY = `zevium:orgConsumed:${ORG}`;

  describe("reserveWithCredits", () => {
    it("increments and returns true when creditedUnits - consumed >= cost", async () => {
      mockGet.mockResolvedValueOnce(10);
      const ok = await gate.reserveWithCredits(ORG, CREDITED, COST);
      expect(ok).toBe(true);
      expect(mockGet).toHaveBeenCalledWith(KEY);
      expect(mockIncrby).toHaveBeenCalledWith(KEY, COST);
    });

    it("returns false (no increment) when insufficient", async () => {
      mockGet.mockResolvedValueOnce(98); // credited 100 - 98 = 2 < cost 5
      const ok = await gate.reserveWithCredits(ORG, CREDITED, COST);
      expect(ok).toBe(false);
      expect(mockIncrby).not.toHaveBeenCalled();
    });

    it("treats a missing consumed key as 0", async () => {
      mockGet.mockResolvedValueOnce(null);
      const ok = await gate.reserveWithCredits(ORG, COST, COST);
      expect(ok).toBe(true);
    });

    it("rejects non-positive cost without touching Redis", async () => {
      const ok = await gate.reserveWithCredits(ORG, CREDITED, 0);
      expect(ok).toBe(false);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("propagates Redis errors", async () => {
      mockGet.mockRejectedValueOnce(new Error("connection refused"));
      await expect(gate.reserveWithCredits(ORG, CREDITED, COST)).rejects.toThrow("connection refused");
    });
  });

  describe("refund", () => {
    it("decrements and returns true when consumed >= cost", async () => {
      mockGet.mockResolvedValueOnce(10);
      const ok = await gate.refund(ORG, COST);
      expect(ok).toBe(true);
      expect(mockIncrby).toHaveBeenCalledWith(KEY, -COST);
    });

    it("returns false (no decrement) when consumed < cost", async () => {
      mockGet.mockResolvedValueOnce(2);
      const ok = await gate.refund(ORG, COST);
      expect(ok).toBe(false);
      expect(mockIncrby).not.toHaveBeenCalled();
    });
  });

  describe("peek", () => {
    it("returns creditedUnits - consumed", async () => {
      mockGet.mockResolvedValueOnce(20);
      const available = await gate.peek(ORG, CREDITED);
      expect(available).toBe(80);
    });

    it("clamps to 0 when consumed exceeds creditedUnits", async () => {
      mockGet.mockResolvedValueOnce(150);
      const available = await gate.peek(ORG, CREDITED);
      expect(available).toBe(0);
    });

    it("propagates Redis errors", async () => {
      mockGet.mockRejectedValueOnce(new Error("oom"));
      await expect(gate.peek(ORG, CREDITED)).rejects.toThrow("oom");
    });
  });

  describe("readConsumed", () => {
    it("reads consumed from kv.get", async () => {
      mockGet.mockResolvedValueOnce(42);
      expect(await gate.readConsumed(ORG)).toBe(42);
      expect(mockGet).toHaveBeenCalledWith(KEY);
    });

    it("returns 0 when key missing", async () => {
      mockGet.mockResolvedValueOnce(null);
      expect(await gate.readConsumed(ORG)).toBe(0);
    });

    it("self-heals a negative counter to 0", async () => {
      mockGet.mockResolvedValueOnce(-5);
      expect(await gate.readConsumed(ORG)).toBe(0);
      expect(mockSet).toHaveBeenCalledWith(KEY, 0);
    });
  });

  describe("initOrgConsumed", () => {
    it("calls kv.set with nx option", async () => {
      mockSet.mockResolvedValueOnce("OK");
      await gate.initOrgConsumed(ORG);
      expect(mockSet).toHaveBeenCalledWith(KEY, 0, { nx: true });
    });
  });
});
