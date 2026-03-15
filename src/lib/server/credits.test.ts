import { beforeEach, describe, expect, it, vi } from "vitest";

interface BitfieldCommandMock {
  get: (encoding: "u63", offset: 0) => GetCommandMock;
  overflow: (mode: "FAIL") => OverflowCommandMock;
}
interface GetCommandMock {
  exec: () => Promise<RedisBitfieldResponse>;
}

interface IncrByCommandMock {
  exec: () => Promise<RedisBitfieldResponse>;
}

interface LedgerStreamEntry {
  amountCents: string;
  createdAt: string;
  description: string;
  id: string;
  reference: string;
  type: "adjust" | "deduct" | "topup";
  userId: string;
}

interface LedgerStreamOptions {
  trim: {
    comparison: "~";
    threshold: number;
    type: "MAXLEN";
  };
}

interface OverflowCommandMock {
  incrby: (encoding: "u63", offset: 0, amount: number) => IncrByCommandMock;
}

type RedisBitfieldResponse = readonly [RedisBitfieldValue] | RedisBitfieldValue;

type RedisBitfieldValue = null | number | string;

const mocks = vi.hoisted(() => {
  const getExecMock = vi.fn<() => Promise<RedisBitfieldResponse>>();
  const overflowExecMock = vi.fn<() => Promise<RedisBitfieldResponse>>();
  const xaddMock =
    vi.fn<(streamKey: string, id: "*", entry: LedgerStreamEntry, options: LedgerStreamOptions) => Promise<string>>();

  const getMock = vi.fn<BitfieldCommandMock["get"]>();
  getMock.mockImplementation(() => ({
    exec: getExecMock,
  }));

  const incrbyMock = vi.fn<OverflowCommandMock["incrby"]>();
  incrbyMock.mockImplementation(() => ({
    exec: overflowExecMock,
  }));

  const overflowMock = vi.fn<BitfieldCommandMock["overflow"]>();
  overflowMock.mockImplementation(() => ({
    incrby: incrbyMock,
  }));

  const bitfieldMock = vi.fn<(key: string) => BitfieldCommandMock>();
  bitfieldMock.mockImplementation(() => ({
    get: getMock,
    overflow: overflowMock,
  }));

  return {
    bitfieldMock,
    getExecMock,
    getMock,
    incrbyMock,
    overflowExecMock,
    overflowMock,
    xaddMock,
  };
});

vi.mock("@paralleldrive/cuid2", () => ({
  createId: vi.fn((): string => "ledger-entry-id"),
}));

vi.mock("~/lib/server/kv", () => ({
  kv: {
    bitfield: mocks.bitfieldMock,
    xadd: mocks.xaddMock,
  },
}));

import { CreditsManager, CreditsRedisKey } from "./credits";

describe("CreditsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  describe("getBalance", () => {
    it("returns 0 when Redis returns null", async () => {
      mocks.getExecMock.mockResolvedValueOnce([null]);

      await expect(CreditsManager.getBalance("user-1")).resolves.toBe(0);

      expect(mocks.bitfieldMock).toHaveBeenCalledWith(CreditsRedisKey.balance("user-1"));
      expect(mocks.getMock).toHaveBeenCalledWith("u63", 0);
    });

    it("returns parsed integer when Redis returns a number string", async () => {
      mocks.getExecMock.mockResolvedValueOnce(["123.9"]);

      await expect(CreditsManager.getBalance("user-1")).resolves.toBe(123);
    });

    it("clamps invalid Redis values to 0", async () => {
      mocks.getExecMock.mockResolvedValueOnce(["not-a-number"]);

      await expect(CreditsManager.getBalance("user-1")).resolves.toBe(0);
    });
  });

  describe("add", () => {
    it("increments the balance and appends a topup ledger event", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([1500]);
      mocks.xaddMock.mockResolvedValueOnce("stream-id");
      mocks.getExecMock.mockResolvedValueOnce([1500]);

      await expect(
        CreditsManager.add({
          amountCents: 500,
          description: "Polar top-up",
          reference: "order-1",
          userId: "user-1",
        }),
      ).resolves.toBe(1500);

      expect(mocks.bitfieldMock).toHaveBeenCalledWith(CreditsRedisKey.balance("user-1"));
      expect(mocks.overflowMock).toHaveBeenCalledWith("FAIL");
      expect(mocks.incrbyMock).toHaveBeenCalledWith("u63", 0, 500);
      expect(mocks.xaddMock).toHaveBeenCalledWith(
        CreditsRedisKey.ledgerStream(),
        "*",
        expect.objectContaining({
          amountCents: "500",
          createdAt: "1700000000000",
          description: "Polar top-up",
          id: "ledger-entry-id",
          reference: "order-1",
          type: "topup",
          userId: "user-1",
        }),
        {
          trim: {
            comparison: "~",
            threshold: 100_000,
            type: "MAXLEN",
          },
        },
      );
    });

    it("throws when the bitfield increment overflows", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([null]);

      await expect(
        CreditsManager.add({
          amountCents: 500,
          userId: "user-1",
        }),
      ).rejects.toThrow("Credit balance overflow");

      expect(mocks.xaddMock).not.toHaveBeenCalled();
    });

    it("rejects if the ledger append fails after the balance mutation", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([1500]);
      mocks.xaddMock.mockRejectedValueOnce(new Error("xadd failed"));

      await expect(
        CreditsManager.add({
          amountCents: 500,
          userId: "user-1",
        }),
      ).rejects.toThrow("xadd failed");
    });
  });

  describe("deduct", () => {
    it("decrements the balance and appends a deduct ledger event", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([700]);
      mocks.xaddMock.mockResolvedValueOnce("stream-id");

      await expect(
        CreditsManager.deduct({
          amountCents: 300,
          reason: "Usage",
          reference: "req-1",
          userId: "user-1",
        }),
      ).resolves.toBe(700);

      expect(mocks.incrbyMock).toHaveBeenCalledWith("u63", 0, -300);
      expect(mocks.xaddMock).toHaveBeenCalledWith(
        CreditsRedisKey.ledgerStream(),
        "*",
        expect.objectContaining({
          amountCents: "-300",
          createdAt: "1700000000000",
          description: "Usage",
          id: "ledger-entry-id",
          reference: "req-1",
          type: "deduct",
          userId: "user-1",
        }),
        {
          trim: {
            comparison: "~",
            threshold: 100_000,
            type: "MAXLEN",
          },
        },
      );
    });

    it("throws insufficient credits when Redis reports underflow", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([null]);

      await expect(
        CreditsManager.deduct({
          amountCents: 300,
          userId: "user-1",
        }),
      ).rejects.toThrow("Insufficient credits");

      expect(mocks.xaddMock).not.toHaveBeenCalled();
    });

    it("throws insufficient credits when Redis returns a non-finite value", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce(["not-a-number"]);

      await expect(
        CreditsManager.deduct({
          amountCents: 300,
          userId: "user-1",
        }),
      ).rejects.toThrow("Insufficient credits");

      expect(mocks.xaddMock).not.toHaveBeenCalled();
    });

    it("rejects if the ledger append fails after the balance mutation", async () => {
      mocks.overflowExecMock.mockResolvedValueOnce([700]);
      mocks.xaddMock.mockRejectedValueOnce(new Error("xadd failed"));

      await expect(
        CreditsManager.deduct({
          amountCents: 300,
          userId: "user-1",
        }),
      ).rejects.toThrow("xadd failed");
    });
  });
});
