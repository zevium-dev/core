import { describe, expect, it, vi } from "vitest";
import { revokeWithLocalPreflight } from "./api-key-lifecycle";

function fixture() {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      loadOwnedKey: vi.fn(async () => {
        calls.push("verify");
        return { revoked: false };
      }),
      reserveLocalGate: vi.fn(async () => {
        calls.push("reserve");
        return { status: "reserved" as const };
      }),
      revokeExternal: vi.fn(async () => {
        calls.push("revoke");
      }),
      completeLocal: vi.fn(async () => {
        calls.push("complete");
      }),
      compensateLocal: vi.fn(async () => {
        calls.push("compensate");
      }),
    },
  };
}

describe("revokeWithLocalPreflight", () => {
  it("orders ownership and local reservation before destructive Clerk call", async () => {
    const { calls, dependencies } = fixture();
    await revokeWithLocalPreflight(dependencies);
    expect(calls).toEqual(["verify", "reserve", "revoke", "complete"]);
  });

  it("cannot touch Clerk when ownership or local authorization fails", async () => {
    for (const stage of ["verify", "reserve"] as const) {
      const { dependencies } = fixture();
      dependencies[
        stage === "verify" ? "loadOwnedKey" : "reserveLocalGate"
      ].mockRejectedValueOnce(new Error("denied"));
      await expect(revokeWithLocalPreflight(dependencies)).rejects.toThrow(
        "denied",
      );
      expect(dependencies.revokeExternal).not.toHaveBeenCalled();
    }
  });

  it("compensates failed external revoke but never re-enables after terminal revoke", async () => {
    const failed = fixture();
    failed.dependencies.revokeExternal.mockRejectedValueOnce(
      new Error("Clerk unavailable"),
    );
    await expect(revokeWithLocalPreflight(failed.dependencies)).rejects.toThrow(
      "Clerk unavailable",
    );
    expect(failed.calls).toEqual(["verify", "reserve", "compensate"]);
    expect(failed.dependencies.revokeExternal).toHaveBeenCalledOnce();

    const completionFailed = fixture();
    completionFailed.dependencies.completeLocal.mockRejectedValueOnce(
      new Error("Convex unavailable"),
    );
    await expect(
      revokeWithLocalPreflight(completionFailed.dependencies),
    ).rejects.toThrow("Convex unavailable");
    expect(
      completionFailed.dependencies.compensateLocal,
    ).not.toHaveBeenCalled();
  });
});
