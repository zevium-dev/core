import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEval = vi.fn();
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("~/lib/server/kv", () => ({
  kv: { eval: mockEval, get: mockGet, set: mockSet },
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

  describe("reserve", () => {
    it("returns true when lua returns 1", async () => {
      mockEval.mockResolvedValueOnce(1);
      const ok = await gate.reserve(ORG, COST);
      expect(ok).toBe(true);
      expect(mockEval).toHaveBeenCalledTimes(1);
      const [, keys, args] = mockEval.mock.calls[0];
      expect(keys).toContain(`zevium:orgConsumed:${ORG}`);
      expect(args).toContain(COST);
    });

    it("returns false when lua returns 0", async () => {
      mockEval.mockResolvedValueOnce(0);
      const ok = await gate.reserve(ORG, COST);
      expect(ok).toBe(false);
    });

    it("propagates Redis errors (no try/catch in reserve)", async () => {
      mockEval.mockRejectedValueOnce(new Error("connection refused"));
      await expect(gate.reserve(ORG, COST)).rejects.toThrow("connection refused");
    });
  });

  describe("reserveWithCredits", () => {
    it("returns true when creditedUnits - consumed >= cost", async () => {
      mockEval.mockResolvedValueOnce(1);
      const ok = await gate.reserveWithCredits(ORG, CREDITED, COST);
      expect(ok).toBe(true);
    });

    it("returns false when insufficient", async () => {
      mockEval.mockResolvedValueOnce(0);
      const ok = await gate.reserveWithCredits(ORG, 2, COST);
      expect(ok).toBe(false);
    });
  });

  describe("refund", () => {
    it("returns true on success", async () => {
      mockEval.mockResolvedValueOnce(1);
      const ok = await gate.refund(ORG, COST);
      expect(ok).toBe(true);
    });

    it("returns false when cur < cost", async () => {
      mockEval.mockResolvedValueOnce(0);
      const ok = await gate.refund(ORG, COST);
      expect(ok).toBe(false);
    });
  });

  describe("peek", () => {
    it("returns available units", async () => {
      mockEval.mockResolvedValueOnce(80);
      const available = await gate.peek(ORG, CREDITED);
      expect(available).toBe(80);
    });

    it("propagates Redis errors", async () => {
      mockEval.mockRejectedValueOnce(new Error("oom"));
      await expect(gate.peek(ORG, CREDITED)).rejects.toThrow("oom");
    });
  });

  describe("readConsumed", () => {
    it("reads consumed from kv.get", async () => {
      mockGet.mockResolvedValueOnce(42);
      const consumed = await gate.readConsumed(ORG);
      expect(consumed).toBe(42);
      expect(mockGet).toHaveBeenCalledWith(`zevium:orgConsumed:${ORG}`);
    });

    it("returns 0 when key missing", async () => {
      mockGet.mockResolvedValueOnce(null);
      const consumed = await gate.readConsumed(ORG);
      expect(consumed).toBe(0);
    });

    it("returns 0 when value is undefined", async () => {
      mockGet.mockResolvedValueOnce(undefined);
      const consumed = await gate.readConsumed(ORG);
      expect(consumed).toBe(0);
    });
  });

  describe("initOrgConsumed", () => {
    it("calls kv.set with nx option", async () => {
      mockSet.mockResolvedValueOnce("OK");
      await gate.initOrgConsumed(ORG);
      expect(mockSet).toHaveBeenCalledWith(
        `zevium:orgConsumed:${ORG}`,
        0,
        { nx: true },
      );
    });
  });
});