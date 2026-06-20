import { beforeEach, describe, expect, it, vi } from "vitest";

import { type ServerEnv, serverEnv } from "~/env/server";

import { clearKeyRingCache, getAllKeyIds, getKeyById, getKeyRing, getPrimaryKey } from "./secrets-keyring";

// You absolute skibidi toilet, I'm mocking the server env because you're too dumb to provide a real one
vi.mock("~/env/server", () => ({
  serverEnv: {
    SECRETS_KEYS_JSON: [
      {
        id: "v1",
        // 32 bytes of 'a'
        key: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
      },
    ],
    SECRETS_PRIMARY_KEY_ID: "v1",
  },
}));

// Cast to ServerEnv because the mock is not typed and you're too lazy to do it right
const mockServerEnv = serverEnv;

describe("secrets-keyring", () => {
  beforeEach(() => {
    // Reset the cache before each test so your trash code doesn't pollute other tests
    clearKeyRingCache();
    vi.clearAllMocks();
  });

  describe("Successful Initialization", () => {
    it("should initialize the keyring and retrieve the primary key", async () => {
      const primaryKey = await getPrimaryKey();
      expect(primaryKey.id).toBe("v1");
      expect(primaryKey.key).toBeInstanceOf(CryptoKey);
    });

    it("should retrieve a key by ID", async () => {
      const key = await getKeyById("v1");
      expect(key?.id).toBe("v1");
      expect(key?.key).toBeInstanceOf(CryptoKey);
    });

    it("should return all key IDs", async () => {
      const ids = await getAllKeyIds();
      expect(ids).toEqual(["v1"]);
    });
  });

  describe("Key Validation", () => {
    it("should throw InvalidKeyBytesError if key is not 32 bytes", async () => {
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v1", key: "YWFh" }]; // 3 bytes

      await expect(getKeyRing()).rejects.toThrow("Key 'v1' must be 32 bytes");
    });
  });

  describe("Duplicate Key Detection", () => {
    it("should throw DuplicateKeyError if IDs collide", async () => {
      const key = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
      mockServerEnv.SECRETS_KEYS_JSON = [
        { id: "v1", key },
        { id: "v1", key },
      ];

      await expect(getKeyRing()).rejects.toThrow("Duplicate key ID: v1");
    });
  });

  describe("Primary Key Lookup & Key Retrieval", () => {
    it("should return the correct primary key when multiple keys exist", async () => {
      const key1 = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
      const key2 = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=";

      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v2";
      mockServerEnv.SECRETS_KEYS_JSON = [
        { id: "v1", key: key1 },
        { id: "v2", key: key2 },
      ];

      const primaryKey = await getPrimaryKey();
      expect(primaryKey.id).toBe("v2");

      const keyV1 = await getKeyById("v1");
      expect(keyV1?.id).toBe("v1");
    });
  });

  describe("Error Conditions", () => {
    it("should throw PrimaryKeyNotFoundError if primary key ID is missing", async () => {
      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v99";
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v1", key: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=" }];

      await expect(getPrimaryKey()).rejects.toThrow("SECRETS_PRIMARY_KEY_ID 'v99' not found in SECRETS_KEYS_JSON");
    });

    it("should throw when base64 is invalid", async () => {
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v1", key: "not-valid-base64-!!!" }];

      await expect(getKeyRing()).rejects.toThrow();
    });
  });

  describe("Caching Behavior", () => {
    it("should cache the keyring after first initialization", async () => {
      const key1 = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
      const key2 = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=";

      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v1";
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v1", key: key1 }];

      const ring1 = await getKeyRing();
      expect(ring1.primaryKeyId).toBe("v1");

      // Change env without clearing cache - should still return old values
      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v2";
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v2", key: key2 }];

      const ring2 = await getKeyRing();
      expect(ring2.primaryKeyId).toBe("v1");
      expect(ring2).toBe(ring1);
    });

    it("should re-initialize when cache is cleared", async () => {
      const key1 = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
      const key2 = "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=";

      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v1";
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v1", key: key1 }];

      await getKeyRing();

      clearKeyRingCache();

      // Change env and clear cache - should return new values
      mockServerEnv.SECRETS_PRIMARY_KEY_ID = "v2";
      mockServerEnv.SECRETS_KEYS_JSON = [{ id: "v2", key: key2 }];

      const ring2 = await getKeyRing();
      expect(ring2.primaryKeyId).toBe("v2");
    });
  });
});
