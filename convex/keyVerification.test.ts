/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const provider = vi.hoisted(() => ({ get: vi.fn(), revoke: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ apiKeys: provider }),
}));
const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.resetAllMocks());

describe("provider revoke compensation", () => {
  it("retries outages durably without restoring local key state", async () => {
    const t = convexTest(schema, modules);
    provider.get.mockRejectedValue(new Error("Private provider details"));
    await t.action(internal.keyVerification.revokeWithRetry, {
      keyId: "key_cleanup",
      attempt: 0,
    });
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.args).toEqual([{ keyId: "key_cleanup", attempt: 1 }]);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("treats an already revoked provider key as success", async () => {
    const t = convexTest(schema, modules);
    provider.get.mockResolvedValue({ revoked: true });
    await t.action(internal.keyVerification.revokeWithRetry, {
      keyId: "key_cleanup",
      attempt: 0,
    });
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toEqual([]);
  });

  it("revokes a live provider key and bounds retries with a static failure", async () => {
    const t = convexTest(schema, modules);
    provider.get.mockResolvedValue({ revoked: false });
    provider.revoke.mockResolvedValue({});
    await t.action(internal.keyVerification.revokeWithRetry, {
      keyId: "key_cleanup",
      attempt: 0,
    });
    expect(provider.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_cleanup",
      revocationReason: "Zevium key revoked",
    });
    provider.get.mockRejectedValue(new Error("Private provider details"));
    await expect(
      t.action(internal.keyVerification.revokeWithRetry, {
        keyId: "key_cleanup",
        attempt: 5,
      }),
    ).rejects.toThrow(
      "Provider key cleanup exhausted retries; local revocation remains effective",
    );
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toEqual([]);
  });
});
