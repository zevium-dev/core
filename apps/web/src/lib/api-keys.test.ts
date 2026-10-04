import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
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
import { createKey } from "./api-keys";

beforeEach(() => {
  vi.stubEnv("VITE_CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("REGISTRY_KEY_PROJECTION_HMAC_SECRET", "test-projection-secret");
  mocks.list.mockResolvedValue({ data: [] });
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
    expect(mocks.mutation).toHaveBeenNthCalledWith(
      2,
      api.keySettings.registerOwnedKey,
      { keyId: "key_qa", keyName: "QA agent" },
    );
    expect(result.name).toBe("QA agent");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("revokes the new key if attribution cannot be recorded", async () => {
    mocks.mutation
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Attribution unavailable"));

    await expect(createKey({ data: { name: "QA agent" } })).rejects.toThrow(
      "Attribution unavailable",
    );
    expect(mocks.revoke).toHaveBeenCalledWith({
      apiKeyId: "key_qa",
      revocationReason: "Zevium key projection failed",
    });
  });
});
