import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@clerk/tanstack-react-start/server", () => ({
  auth: async () => ({
    userId: "user_qa",
    orgId: "org_qa",
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
  sealOneTimeExecutionKey: async () => ({ provision: {} }),
  signRegistryVerifiedKeyProjection: async () => "signature",
  signRegistryVerifiedKeyRotationProjection: vi.fn(),
}));

import { api } from "./convex-api";
import { createKey, revokeKey } from "./api-keys";

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
