import { describe, expect, it, vi } from "vitest";

import { decryptSecret, encryptSecret, InvalidSecretFormatError } from "./crypto-secrets";
import { getKeyById, getPrimaryKey } from "./secrets-keyring";

vi.mock("./secrets-keyring", () => ({
  getKeyById: vi.fn(),
  getPrimaryKey: vi.fn(),
}));

describe("crypto-secrets", () => {
  const mockKey = {
    id: "v1",
    key: {} as CryptoKey,
  };

  describe("decryptSecret", () => {
    it("should throw InvalidSecretFormatError for wrong number of parts", async () => {
      await expect(decryptSecret("v1:abc")).rejects.toThrow(InvalidSecretFormatError);
      await expect(decryptSecret("v1:abc:def:ghi")).rejects.toThrow(InvalidSecretFormatError);
    });

    it("should throw InvalidSecretFormatError for empty parts", async () => {
      await expect(decryptSecret(":iv:ct")).rejects.toThrow(InvalidSecretFormatError);
      await expect(decryptSecret("v1::ct")).rejects.toThrow(InvalidSecretFormatError);
      await expect(decryptSecret("v1:iv:")).rejects.toThrow(InvalidSecretFormatError);
      await expect(decryptSecret("::")).rejects.toThrow(InvalidSecretFormatError);
    });

    it("should proceed to key lookup if format is correct", async () => {
      vi.mocked(getKeyById).mockResolvedValueOnce(undefined);
      await expect(decryptSecret("v1:iv:ct")).rejects.toThrow("Failed to decrypt secret");
      expect(getKeyById).toHaveBeenCalledWith("v1");
    });
  });

  describe("encryptSecret", () => {
    it("should return format keyId:base64(iv):base64(ct)", async () => {
      vi.mocked(getPrimaryKey).mockResolvedValueOnce(mockKey);

      // Mock crypto.subtle
      const mockIv = new Uint8Array(12).fill(1);
      const mockCt = new Uint8Array([2, 3, 4]);

      vi.stubGlobal("crypto", {
        getRandomValues: vi.fn().mockReturnValue(mockIv),
        subtle: {
          encrypt: vi.fn().mockResolvedValue(mockCt.buffer),
        },
      });

      const result = await encryptSecret("hello");
      const parts = result.split(":");
      expect(parts).toHaveLength(3);
      expect(parts.at(0)).toBe("v1");
      expect(parts.at(1)).toBe(btoa(String.fromCharCode(...mockIv)));
      expect(parts.at(2)).toBe(btoa(String.fromCharCode(...mockCt)));
    });
  });
});
