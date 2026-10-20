import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  iat: undefined as number | undefined,
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  seal: vi.fn(),
}));

vi.mock("@clerk/tanstack-react-start/server", () => ({
  auth: async () => ({
    userId: "user_qa",
    orgId: "org_qa",
    sessionClaims: mocks.iat === undefined ? null : { iat: mocks.iat },
    getToken: async () => "session-token",
  }),
  clerkClient: async () => ({ apiKeys: mocks }),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (handler: () => unknown) => handler,
    validator: (validate: (input: unknown) => unknown) => ({
      handler:
        (handler: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) }),
    }),
  }),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query = mocks.query;
    mutation = mocks.mutation;
  },
}));
vi.mock("@zevium/shared", () => ({
  sealOneTimeExecutionKey: mocks.seal,
  signRegistryVerifiedKeyProjection: async () => "signature",
  signRegistryVerifiedKeyRotationProjection: async () => "rotation-signature",
}));

import { getFunctionName } from "convex/server";
import { api } from "./convex-api";
import { ROTATION_FAILED_MESSAGE } from "./api-key-error";
import { createKey, revokeKey, rotateKey } from "./api-keys";

beforeEach(() => {
  vi.stubEnv("VITE_CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("REGISTRY_KEY_PROJECTION_HMAC_SECRET", "test-projection-secret");
  mocks.list.mockResolvedValue({ data: [] });
  mocks.get.mockResolvedValue({ id: "key_qa", revoked: false });
  mocks.query.mockResolvedValue([]);
  mocks.create.mockResolvedValue({
    id: "key_qa",
    name: "QA agent",
    secret: "one-time-secret",
    createdAt: 1,
  });
  mocks.mutation.mockResolvedValue({});
  mocks.revoke.mockResolvedValue({});
  mocks.seal.mockResolvedValue({ provision: {} });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("API key creation attribution", () => {
  it("records the provider key name before returning its secret", async () => {
    const result = await createKey({ data: { name: " QA agent " } });

    expect(mocks.mutation).toHaveBeenNthCalledWith(
      1,
      api.keySettings.registerVerified,
      expect.objectContaining({ signature: "signature" }),
    );
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
    expect(mocks.mutation).toHaveBeenCalledWith(
      api.keySettings.registerVerified,
      expect.objectContaining({ keyName: "QA agent" }),
    );
    expect(result.name).toBe("QA agent");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("stamps membership at session mint, before the provider creates the key", async () => {
    vi.useFakeTimers({ now: 1_700_000_100_000 });
    mocks.iat = 1_700_000_040;
    mocks.create.mockImplementation(async () => {
      // A removal webhook stamped during creation must postdate verifiedAt.
      vi.setSystemTime(1_700_000_200_000);
      return { id: "key_qa", name: "QA", secret: "s", createdAt: 1 };
    });
    try {
      await createKey({ data: { name: "QA" } });
    } finally {
      vi.useRealTimers();
      mocks.iat = undefined;
    }
    expect(mocks.mutation).toHaveBeenCalledWith(
      api.keySettings.registerVerified,
      expect.objectContaining({
        projection: expect.objectContaining({ verifiedAt: 1_700_000_040_000 }),
      }),
    );
  });

  it("revokes the new key if attribution cannot be recorded", async () => {
    mocks.mutation.mockRejectedValueOnce(new Error("Attribution unavailable"));

    await expect(createKey({ data: { name: "QA agent" } })).rejects.toThrow(
      "Attribution unavailable",
    );
    expect(mocks.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_qa",
      revocationReason: "Zevium key projection failed",
    });
  });
});

describe("API key revocation ordering", () => {
  it("authorizes and revokes the projection before any provider call", async () => {
    await revokeKey({ data: { id: "key_qa" } });
    expect(mocks.mutation).toHaveBeenCalledWith(
      api.keySettings.revokePrevious,
      { keyId: "key_qa" },
    );
    expect(mocks.mutation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.get.mock.invocationCallOrder[0]!,
    );
    expect(mocks.get.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revoke.mock.invocationCallOrder[0]!,
    );
  });

  it("never touches Clerk when Convex denies authorization", async () => {
    mocks.mutation.mockRejectedValue(new Error("Verified key not found"));
    await expect(revokeKey({ data: { id: "key_qa" } })).rejects.toThrow(
      "Verified key not found",
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("keeps local revocation on Clerk failure and exposes only intentional cleanup copy", async () => {
    mocks.revoke.mockRejectedValue(
      new Error("Sensitive Clerk request details"),
    );
    await expect(revokeKey({ data: { id: "key_qa" } })).resolves.toEqual({
      id: "key_qa",
      providerCleanupPending: true,
    });
    expect(mocks.mutation).toHaveBeenCalledTimes(1);
  });
});

describe("API key rotation", () => {
  const rotate = () =>
    rotateKey({ data: { id: "key_old", operationId: "rotate-op-1" } });
  const completion = (result: object) =>
    mocks.mutation.mockImplementation(async (ref) => {
      const name = getFunctionName(ref);
      if (name === "keySettings:beginRotation") return { status: "reserved" };
      if (name === "keySettings:completeRotation") return result;
      return {};
    });

  beforeEach(() => {
    mocks.get.mockResolvedValue({
      id: "key_old",
      name: "QA agent",
      subject: "user_qa",
      claims: { org_id: "org_qa" },
      revoked: false,
      expired: false,
    });
    mocks.query.mockResolvedValue([
      {
        keyId: "key_old",
        ownerUserId: "user_qa",
        budgetId: "budget_qa",
        budgetRevision: 3,
        monthlyCapCredits: 500,
        disabled: false,
      },
    ]);
    mocks.create.mockResolvedValue({
      id: "key_new",
      name: "QA agent (rotated)",
      secret: "ak_new_secret",
      createdAt: 2,
    });
    completion({ status: "completed" });
  });

  it("keeps the family budget revision Convex requires", async () => {
    const result = await rotate();
    expect(mocks.seal).toHaveBeenCalledWith(
      expect.objectContaining({ budgetId: "budget_qa", budgetRevision: 3 }),
      { monthlyCapCredits: 500 },
    );
    expect(result.secret).toBe("ak_new_secret");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("never returns the minted secret when Convex records the rotation as failed", async () => {
    completion({ status: "failed", newKeyId: "key_new" });
    const outcome = await rotate().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(outcome).not.toHaveProperty("value");
    expect(String((outcome as { error: unknown }).error)).toContain(
      ROTATION_FAILED_MESSAGE,
    );
    expect(JSON.stringify(outcome)).not.toContain("ak_new_secret");
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "key_new" }),
    );
    expect(mocks.mutation).toHaveBeenCalledWith(
      api.keySettings.failRotation,
      expect.objectContaining({
        operationId: "rotate-op-1",
        cleanup: expect.objectContaining({ signature: "rotation-signature" }),
      }),
    );
  });

  it("reports the failure even when provider cleanup fails", async () => {
    completion({ status: "failed" });
    mocks.revoke.mockRejectedValue(new Error("already revoked"));
    await expect(rotate()).rejects.toThrow(ROTATION_FAILED_MESSAGE);
  });
});
