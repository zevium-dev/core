/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  SPEC_IMPORT_LEASE_MS,
  SPEC_IMPORT_RATE_LIMIT,
} from "./specImportLimits";

const modules = import.meta.glob("./**/*.ts");

function asUser(userId: string, orgId = "org_import") {
  const t = convexTest(schema, modules);
  return {
    t,
    client: t.withIdentity({
      subject: userId,
      org_id: orgId,
      org_role: "org:member",
    } as { subject: string }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("spec import distributed limiter", () => {
  it("enforces two active leases per exact user+org and releases idempotently", async () => {
    const { client } = asUser("user_one");
    await client.mutation(api.specImportLimits.acquire, {
      leaseId: "lease-0001",
    });
    await client.mutation(api.specImportLimits.acquire, {
      leaseId: "lease-0002",
    });
    await expect(
      client.mutation(api.specImportLimits.acquire, { leaseId: "lease-0003" }),
    ).rejects.toThrow("already running");

    await expect(
      client.mutation(api.specImportLimits.release, { leaseId: "lease-0001" }),
    ).resolves.toEqual({ released: true });
    await expect(
      client.mutation(api.specImportLimits.release, { leaseId: "lease-0001" }),
    ).resolves.toEqual({ released: false });
    await expect(
      client.mutation(api.specImportLimits.acquire, { leaseId: "lease-0003" }),
    ).resolves.toMatchObject({ leaseId: "lease-0003" });
  });

  it("isolates scope and enforces exact fixed-window request budget", async () => {
    const t = convexTest(schema, modules);
    const first = t.withIdentity({
      subject: "user_one",
      org_id: "org_import",
    } as { subject: string });
    const second = t.withIdentity({
      subject: "user_two",
      org_id: "org_import",
    } as { subject: string });
    for (let index = 0; index < SPEC_IMPORT_RATE_LIMIT; index += 1) {
      const leaseId = `lease-rate-${String(index).padStart(3, "0")}`;
      await first.mutation(api.specImportLimits.acquire, { leaseId });
      await first.mutation(api.specImportLimits.release, { leaseId });
    }
    await expect(
      first.mutation(api.specImportLimits.acquire, {
        leaseId: "lease-over-limit",
      }),
    ).rejects.toThrow("limit reached");
    await expect(
      second.mutation(api.specImportLimits.acquire, {
        leaseId: "lease-other-user",
      }),
    ).resolves.toMatchObject({ leaseId: "lease-other-user" });
  });

  it("expires abandoned leases without operator cleanup", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { client } = asUser("user_expiry");
    await client.mutation(api.specImportLimits.acquire, {
      leaseId: "lease-expiry-1",
    });
    await client.mutation(api.specImportLimits.acquire, {
      leaseId: "lease-expiry-2",
    });
    now += SPEC_IMPORT_LEASE_MS + 1;
    await expect(
      client.mutation(api.specImportLimits.acquire, {
        leaseId: "lease-expiry-3",
      }),
    ).resolves.toMatchObject({ leaseId: "lease-expiry-3" });
  });
});
