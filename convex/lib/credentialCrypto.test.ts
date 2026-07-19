import { afterEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./credentialCrypto";

const previous = process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
afterEach(() => {
  if (previous === undefined)
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
  else process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = previous;
});

function keyring(current: string, keys: Record<string, string>) {
  process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
    current,
    keys,
  });
}

describe("credential keyring", () => {
  it("decrypts ciphertext after current key rotation while old material remains", async () => {
    keyring("v1", { v1: "one" });
    const encrypted = await encryptCredential("secret");
    keyring("v2", { v1: "one", v2: "two" });
    expect(await decryptCredential(encrypted)).toBe("secret");
    expect((await encryptCredential("next")).keyVersion).toBe("v2");
  });

  it("fails safely for missing keyring material and corrupt ciphertext", async () => {
    delete process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS;
    await expect(encryptCredential("secret")).rejects.toThrow(/keyring/);
    keyring("v1", { v1: "one" });
    await expect(
      decryptCredential({ ciphertext: "bad", iv: "bad", keyVersion: "v1" }),
    ).rejects.toThrow(/cannot be decrypted/);
  });
});
