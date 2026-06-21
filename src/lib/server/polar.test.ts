import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Polar SDK - expose the mock object so we can control it per-test
const mockPolar: Record<string, any> = {
  customers: { getExternal: vi.fn(), create: vi.fn(), getStateExternal: vi.fn() },
  checkouts: { create: vi.fn() },
  events: { ingest: vi.fn() },
};

vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    customers: any;
    checkouts: any;
    events: any;
    constructor() {
      this.customers = mockPolar.customers;
      this.checkouts = mockPolar.checkouts;
      this.events = mockPolar.events;
    }
  },
}));

vi.mock("~/env/server", () => ({
  serverEnv: {
    POLAR_ACCESS_TOKEN: "test",
    POLAR_METER_ID: "mtr_test",
    POLAR_ORGANIZATION_ID: "org_test",
    POLAR_PRODUCT_ID_CREDITS: "prd_test",
    POLAR_SERVER: "sandbox",
    POLAR_WEBHOOK_SECRET: "test",
    PROXY_HOST_UNIT_COSTS: { "api.openai.com": 3 },
    PROXY_PUBLIC_HOST: "localhost:5173",
    PROXY_REQUEST_TIMEOUT_MS: 30000,
    PROXY_ALLOWED_HOSTS: "api.openai.com",
    PROXY_UPSTREAM_SECRET: "test",
    LIBSQL_URL: "libsql://test.turso.io",
    LIBSQL_SECRET: "test",
  },
}));

const chain = () => ({
  from: vi.fn(chain),
  where: vi.fn(chain),
  set: vi.fn(chain),
  limit: vi.fn(() => ({ then: vi.fn((cb: any) => cb([{ polarCustomerId: "cust_123" }])) })),
  then: vi.fn((cb: any) => cb([{ polarCustomerId: "cust_123" }])),
});

vi.mock("~/db", () => ({
  db: { select: vi.fn(chain), update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })) },
  schema: { organization: { polarCustomerId: {}, id: {}, polarBillingEmail: {} } },
  orm: { eq: vi.fn(), and: vi.fn(), count: vi.fn() },
}));

vi.mock("~/lib/server/kv", () => ({ kv: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));

import { kv } from "~/lib/server/kv";

describe("polar helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Reset mockPolar internals since polarClient is a module-level singleton
    Object.values(mockPolar).forEach((v: any) =>
      Object.values(v).forEach((m: any) => {
        if (typeof m === "function") m.mockReset();
      }),
    );
  });

  const org = { id: "org1", name: "Test Org", slug: "test-org" };

  describe("ensureOrgCustomer", () => {
    it("returns existing customer", async () => {
      mockPolar.customers.getExternal.mockResolvedValueOnce({ id: "cust_123" });
      const { ensureOrgCustomer } = await import("./polar");
      const cust = await ensureOrgCustomer(org as any);
      expect(cust.id).toBe("cust_123");
    });

    it("creates customer if not found", async () => {
      mockPolar.customers.getExternal.mockRejectedValueOnce(new Error("not found"));
      mockPolar.customers.create.mockResolvedValueOnce({ id: "cust_new" });
      const { ensureOrgCustomer } = await import("./polar");
      const cust = await ensureOrgCustomer(org as any);
      expect(cust.id).toBe("cust_new");
    });
  });

  describe("getOrgCreditedUnits", () => {
    it("returns cached value", async () => {
      (kv.get as any).mockResolvedValueOnce(500);
      const { getOrgCreditedUnits } = await import("./polar");
      const units = await getOrgCreditedUnits("org1");
      expect(units).toBe(500);
    });

    it("fetches from Polar on cache miss", async () => {
      (kv.get as any).mockResolvedValueOnce(null);
      mockPolar.customers.getStateExternal.mockResolvedValueOnce({
        activeMeters: [{ meterId: "mtr_test", creditedUnits: 200, consumedUnits: 50 }],
      });
      const { getOrgCreditedUnits } = await import("./polar");
      const units = await getOrgCreditedUnits("org1");
      expect(units).toBe(200);
    });

    it("throws on Polar error", async () => {
      (kv.get as any).mockResolvedValueOnce(null);
      mockPolar.customers.getStateExternal.mockRejectedValueOnce(new Error("oops"));
      const { getOrgCreditedUnits } = await import("./polar");
      await expect(getOrgCreditedUnits("org1")).rejects.toThrow("oops");
    });
  });

  describe("createCreditsCheckout", () => {
    it("calls Polar checkout", async () => {
      mockPolar.customers.getExternal.mockResolvedValueOnce({ id: "cust_123" });
      mockPolar.checkouts.create.mockResolvedValueOnce({ id: "chk", url: "https://checkout.polar.sh/chk" });
      const { createCreditsCheckout } = await import("./polar");
      const r = await createCreditsCheckout({ orgId: "org1", amountUsd: 20, successUrl: "https://x.com" });
      expect(r.url).toContain("checkout.polar.sh");
    });
  });

  describe("ingestProxyCall", () => {
    it("calls events.ingest", async () => {
      mockPolar.events.ingest.mockResolvedValueOnce({});
      const { ingestProxyCall } = await import("./polar");
      await ingestProxyCall({
        orgId: "org1",
        requestId: "r1",
        host: "api.openai.com",
        method: "POST",
        status: 200,
        costUnits: 3,
      });
      expect(mockPolar.events.ingest).toHaveBeenCalled();
    });
  });
});
