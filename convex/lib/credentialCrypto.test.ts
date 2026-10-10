import { afterEach, describe, expect, it } from "vitest";
import {
  credentialBinding,
  decryptCredential,
  decryptSecret,
  encryptCredential,
  verifyDualSecret,
  webhookBinding,
} from "./credentialCrypto";

const KEY_1 = "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=";
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

describe("credential keyring and envelopes", () => {
  it("dual-writes rollback envelope and AAD-bound v2 envelope", async () => {
    keyring("v1", { v1: KEY_1 });
    const encrypted = await encryptCredential(
      "secret",
      "project_a",
      "authorization",
    );
    expect(encrypted).toMatchObject({
      keyVersion: "v1",
      sealedKeyVersion: "v1",
      sealedVersion: "v2",
    });
    expect(
      await decryptCredential(encrypted, "project_a", "authorization"),
    ).toBe("secret");
    await verifyDualSecret(
      encrypted,
      credentialBinding("project_a", "authorization"),
      "secret",
    );
  });

  it("rejects ciphertext transplant across rows and purposes", async () => {
    keyring("v1", { v1: KEY_1 });
    const encrypted = await encryptCredential(
      "secret",
      "project_a",
      "authorization",
    );
    await expect(
      decryptCredential(encrypted, "project_b", "authorization"),
    ).rejects.toThrow("cannot be decrypted");
    await expect(
      decryptSecret(encrypted, webhookBinding("project_a")),
    ).rejects.toThrow("cannot be decrypted");
  });

  it("keeps legacy-only rows readable during rollback-safe rollout", async () => {
    keyring("v1", { v1: KEY_1 });
    const dual = await encryptCredential("legacy", "project_a", "x-api-key");
    expect(
      await decryptCredential(
        {
          ciphertext: dual.ciphertext,
          iv: dual.iv,
          keyVersion: dual.keyVersion,
        },
        "different_project",
        "different_name",
      ),
    ).toBe("legacy");
  });

  it.each([
    { current: "", keys: { "": KEY_1 } },
    { current: "v1", keys: { v1: "short" } },
    { current: "v1", keys: { v1: `${KEY_1}\n` } },
    { current: "v1", keys: { v1: KEY_1.slice(0, -1) } },
    { current: "v1", keys: { "bad version": KEY_1, v1: KEY_1 } },
  ])("rejects weak or noncanonical keyring %#", async (value) => {
    process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify(value);
    await expect(
      encryptCredential("secret", "project_a", "authorization"),
    ).rejects.toThrow(/keyring is invalid|unavailable for bound envelopes/);
  });
});
