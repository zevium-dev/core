import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "~/db";

import { decryptSecret } from "./crypto-secrets";
import { loadProjectSecret, loadProjectSecrets } from "./project-secrets";

vi.mock("~/db", () => ({
  db: {
    select: vi.fn(),
  },
  orm: {
    and: vi.fn(),
    eq: vi.fn(),
  },
  schema: {
    projectSecret: {
      ciphertext: "ciphertext",
      id: "id",
      name: "name",
      projectId: "projectId",
    },
  },
}));

vi.mock("./crypto-secrets", () => ({
  decryptSecret: vi.fn(),
}));

describe("project-secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Helper to mock drizzle's thenable query builder */
  const mockDrizzleQueryResult = (result: unknown) => {
    const queryMock = {
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (onFulfilled: (value: unknown) => unknown) => {
        return Promise.resolve(result).then(onFulfilled);
      },
      where: vi.fn().mockReturnThis(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (db.select as any).mockReturnValue(queryMock);
    return queryMock;
  };

  describe("loadProjectSecret", () => {
    it("should return plaintext when secret exists and decrypts successfully", async () => {
      mockDrizzleQueryResult([{ ciphertext: "v1:iv:ct", id: "secret-1" }]);
      vi.mocked(decryptSecret).mockResolvedValue("plaintext-value");

      const result = await loadProjectSecret("proj-1", "MY_SECRET");
      expect(result).toBe("plaintext-value");
      expect(decryptSecret).toHaveBeenCalledWith("v1:iv:ct");
    });

    it("should return null when secret does not exist", async () => {
      mockDrizzleQueryResult([]);

      const result = await loadProjectSecret("proj-1", "NON_EXISTENT");
      expect(result).toBeNull();
      expect(decryptSecret).not.toHaveBeenCalled();
    });

    it("should return null and log error when decryption fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
        // Mock implementation
      });

      mockDrizzleQueryResult([{ ciphertext: "bad-format", id: "secret-1" }]);
      vi.mocked(decryptSecret).mockRejectedValue(new Error("Decryption failed"));

      const result = await loadProjectSecret("proj-1", "MY_SECRET");
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decrypt secret 'MY_SECRET'"),
        "Decryption failed",
      );

      consoleSpy.mockRestore();
    });
  });

  describe("loadProjectSecrets", () => {
    it("should return multiple secrets when they exist and decrypt successfully", async () => {
      mockDrizzleQueryResult([
        { ciphertext: "v1:iv:ct1", id: "s1", name: "S1" },
        { ciphertext: "v1:iv:ct2", id: "s2", name: "S2" },
      ]);

      vi.mocked(decryptSecret).mockResolvedValueOnce("val-1").mockResolvedValueOnce("val-2");

      const result = await loadProjectSecrets("proj-1");
      expect(result).toEqual({
        S1: "val-1",
        S2: "val-2",
      });
    });

    it("should gracefully degrade when some secrets fail to decrypt", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
        // Mock implementation
      });

      mockDrizzleQueryResult([
        { ciphertext: "v1:iv:ct1", id: "s1", name: "GOOD" },
        { ciphertext: "v1:iv:ct2", id: "s2", name: "BAD" },
      ]);

      vi.mocked(decryptSecret).mockResolvedValueOnce("val-good").mockRejectedValueOnce(new Error("Decryption failed"));

      const result = await loadProjectSecrets("proj-1");
      expect(result).toEqual({
        GOOD: "val-good",
      });
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });
});
