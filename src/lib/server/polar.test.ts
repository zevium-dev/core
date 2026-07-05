import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPolar, chain } = vi.hoisted(() => {
  const mockPolar: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
    customers: { getExternal: vi.fn(), create: vi.fn(), getStateExternal: vi.fn() },
    events: { ingest: vi.fn() },
  };
  const chain = () => ({
    from: vi.fn(chain),
    limit: vi.fn((cb: (rows: { email: string; name: string }[]) => unknown) => cb([{ email: "u@x.com", name: "U" }])),
    where: vi.fn(chain),
  });
  return { mockPolar, chain };
});

vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    constructor() {
      Object.assign(this, mockPolar);
    }
  },
}));

vi.mock("~/env/server", () => ({
  serverEnv: {
    POLAR_ACCESS_TOKEN: "test",
    POLAR_METER_ID: "mtr_test",
    POLAR_SERVER: "sandbox",
  },
}));

vi.mock("~/db", () => ({
  db: { select: vi.fn(chain) },
  schema: { user: { email: {}, id: {}, name: {} } },
}));

vi.mock("~/lib/server/kv", () => ({ kv: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));

import { kv } from "~/lib/server/kv";
import { ensureUserCustomer, getUserCreditedUnits, ingestProxyCall, invalidateUserCreditedCache } from "./polar";
describe("polar helpers (user-scoped)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const userId = "user1";

  describe("ensureUserCustomer", () => {
    it("returns existing customer id when Polar lookup succeeds", async () => {
      mockPolar.customers.getExternal.mockResolvedValueOnce({ id: "cust_123" });
      const id = await ensureUserCustomer({ userId });
      expect(id).toBe("cust_123");
      expect(mockPolar.customers.getExternal).toHaveBeenCalledWith({ externalId: userId });
    });

    it("creates a customer when Polar lookup throws", async () => {
      mockPolar.customers.getExternal.mockRejectedValueOnce(new Error("not found"));
      mockPolar.customers.create.mockResolvedValueOnce({ id: "cust_new" });
      const id = await ensureUserCustomer({ userId, email: "x@y.com", name: "X" });
      expect(id).toBe("cust_new");
      expect(mockPolar.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "x@y.com", externalId: userId }),
      );
    });
  });

  describe("getUserCreditedUnits", () => {
    it("returns the cached value when present", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(500);
      const units = await getUserCreditedUnits(userId);
      expect(units).toBe(500);
      expect(mockPolar.customers.getStateExternal).not.toHaveBeenCalled();
    });

    it("returns the Polar meter creditedUnits when no cache", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      mockPolar.customers.getStateExternal.mockResolvedValueOnce({
        activeMeters: [
          { meterId: "mtr_test", creditedUnits: 200 },
          { meterId: "other", creditedUnits: 999 },
        ],
      });
      const units = await getUserCreditedUnits(userId);
      expect(units).toBe(200);
      expect(kv.set).toHaveBeenCalledWith(`zevium:creditedUnits:${userId}`, 200, expect.objectContaining({ ex: 300 }));
    });

    it("returns 0 when getStateExternal throws (legacy user / outage)", async () => {
      (kv.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      mockPolar.customers.getStateExternal.mockRejectedValueOnce(new Error("oops"));
      const units = await getUserCreditedUnits(userId);
      expect(units).toBe(0);
    });
  });

  describe("invalidateUserCreditedCache", () => {
    it("deletes the creditedUnits cache key", async () => {
      await invalidateUserCreditedCache(userId);
      expect(kv.del).toHaveBeenCalledWith(`zevium:creditedUnits:${userId}`);
    });
  });

  describe("ingestProxyCall", () => {
    it("calls events.ingest with externalCustomerId = userId", async () => {
      mockPolar.events.ingest.mockResolvedValueOnce({});
      await ingestProxyCall({
        costUnits: 7,
        host: "api.openai.com",
        method: "POST",
        requestId: "req_1",
        status: 200,
        userId,
      });
      expect(mockPolar.events.ingest).toHaveBeenCalledWith({
        events: [
          expect.objectContaining({
            externalCustomerId: userId,
            externalId: "req_1",
            name: "proxy_call",
            metadata: expect.objectContaining({ cost_units: 7 }),
          }),
        ],
      });
    });
  });
});
