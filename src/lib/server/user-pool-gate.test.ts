import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockSet, mockIncrby } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockIncrby: vi.fn(),
}));

vi.mock("~/lib/server/kv", () => ({
  kv: { get: mockGet, incrby: mockIncrby, set: mockSet },
}));

import { initUserConsumed, peekUser, readConsumedUser, refundCredits, reserveCredits } from "./user-pool-gate";

describe("user-pool-gate", () => {
  const USER = "user_abc123";
  const COST = 5;
  const CREDITED = 100;
  const KEY = `zevium:userConsumed:${USER}`;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("reserveCredits", () => {
    it("increments and returns true when creditedUnits - consumed >= cost", async () => {
      mockGet.mockResolvedValueOnce(10);
      const ok = await reserveCredits(USER, CREDITED, COST);
      expect(ok).toBe(true);
      expect(mockGet).toHaveBeenCalledWith(KEY);
      expect(mockIncrby).toHaveBeenCalledWith(KEY, COST);
    });

    it("returns false (no increment) when insufficient", async () => {
      mockGet.mockResolvedValueOnce(98); // credited 100 - 98 = 2 < cost 5
      const ok = await reserveCredits(USER, CREDITED, COST);
      expect(ok).toBe(false);
      expect(mockIncrby).not.toHaveBeenCalled();
    });

    it("treats a missing consumed key as 0", async () => {
      mockGet.mockResolvedValueOnce(null);
      const ok = await reserveCredits(USER, COST, COST);
      expect(ok).toBe(true);
    });

    it("rejects non-positive cost without touching Redis", async () => {
      const ok = await reserveCredits(USER, CREDITED, 0);
      expect(ok).toBe(false);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("propagates Redis errors", async () => {
      mockGet.mockRejectedValueOnce(new Error("connection refused"));
      await expect(reserveCredits(USER, CREDITED, COST)).rejects.toThrow("connection refused");
    });
  });

  describe("refundCredits", () => {
    it("decrements and returns true when consumed >= cost", async () => {
      mockGet.mockResolvedValueOnce(20);
      const ok = await refundCredits(USER, COST);
      expect(ok).toBe(true);
      expect(mockIncrby).toHaveBeenCalledWith(KEY, -COST);
    });

    it("refuses to drive consumed below 0", async () => {
      mockGet.mockResolvedValueOnce(2); // < cost 5
      const ok = await refundCredits(USER, COST);
      expect(ok).toBe(false);
      expect(mockIncrby).not.toHaveBeenCalled();
    });

    it("rejects non-positive cost", async () => {
      const ok = await refundCredits(USER, 0);
      expect(ok).toBe(false);
    });
  });

  describe("peekUser", () => {
    it("returns creditedUnits - consumed", async () => {
      mockGet.mockResolvedValueOnce(30);
      const remaining = await peekUser(USER, 100);
      expect(remaining).toBe(70);
    });

    it("clamps to 0 when consumed exceeds credited", async () => {
      mockGet.mockResolvedValueOnce(150);
      const remaining = await peekUser(USER, 100);
      expect(remaining).toBe(0);
    });
  });

  describe("readConsumedUser", () => {
    it("returns 0 for a missing key", async () => {
      mockGet.mockResolvedValueOnce(null);
      const consumed = await readConsumedUser(USER);
      expect(consumed).toBe(0);
    });

    it("self-heals a negative counter to 0", async () => {
      mockGet.mockResolvedValueOnce(-5);
      const consumed = await readConsumedUser(USER);
      expect(consumed).toBe(0);
      expect(mockSet).toHaveBeenCalledWith(KEY, 0);
    });
  });

  describe("initUserConsumed", () => {
    it("calls kv.set with nx option", async () => {
      mockSet.mockResolvedValueOnce("OK");
      await initUserConsumed(USER);
      expect(mockSet).toHaveBeenCalledWith(KEY, 0, { nx: true });
    });
  });
});
