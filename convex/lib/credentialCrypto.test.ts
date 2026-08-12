import { afterEach, describe, expect, it } from "vitest";
import {
  credentialBinding,
  credentialKeyringPreflight,
  decryptCredential,
  decryptSecret,
  encryptCredential,
  encryptSecret,
  migrateStoredSecret,
  verifyDualSecret,
  webhookBinding,
} from "./credentialCrypto";

const KEY_1 = "MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTE=";
const KEY_2 = "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI=";
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
  it("preflights and decrypts arbitrary legacy key material before v2 migration", async () => {
    const material = "legacy production material was never base64";
    keyring("legacy", { legacy: material });
    expect(credentialKeyringPreflight()).toEqual({
      current: "legacy",
      boundEnvelopeReady: false,
      legacyCompatibleVersions: ["legacy"],
      legacyOnlyVersions: ["legacy"],
    });

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(material),
    );
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
      "encrypt",
    ]);
    const iv = new Uint8Array(12).fill(7);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("legacy-secret"),
    );
    const legacy = {
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      iv: Buffer.from(iv).toString("base64"),
      keyVersion: "legacy",
    };
    await expect(
      decryptSecret(legacy, webhookBinding("project_a")),
    ).resolves.toBe("legacy-secret");

    keyring("v2", { legacy: material, v2: KEY_2 });
    const migrated = await migrateStoredSecret(
      legacy,
      webhookBinding("project_a"),
    );
    expect(migrated).toMatchObject({
      old: true,
      broken: false,
      rewrapped: true,
    });
    await expect(
      decryptSecret(migrated.patch!, webhookBinding("project_a")),
    ).resolves.toBe("legacy-secret");
  });

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

  it("rewraps old versions and verifies both envelopes before patch", async () => {
    keyring("v1", { v1: KEY_1 });
    const old = await encryptSecret("rotate-me", webhookBinding("project_a"));
    keyring("v2", { v1: KEY_1, v2: KEY_2 });
    const migration = await migrateStoredSecret(
      old,
      webhookBinding("project_a"),
    );
    expect(migration).toMatchObject({
      old: true,
      broken: false,
      rewrapped: true,
    });
    expect(migration.patch?.keyVersion).toBe("v2");
    expect(migration.patch?.sealedKeyVersion).toBe("v2");
    expect(
      await decryptSecret(migration.patch!, webhookBinding("project_a")),
    ).toBe("rotate-me");
  });

  it("repairs corrupt hybrid from plaintext only after readback verification", async () => {
    keyring("v1", { v1: KEY_1 });
    const corrupt = {
      ciphertext: "not-base64",
      iv: "also-bad",
      keyVersion: "v1",
      secret: "recoverable",
    };
    const migration = await migrateStoredSecret(
      corrupt,
      credentialBinding("project_a", "authorization"),
    );
    expect(migration).toMatchObject({
      plaintext: true,
      corrupt: true,
      broken: false,
      recovered: true,
      scrubbed: true,
    });
    expect(migration.patch?.secret).toBeUndefined();
    expect(
      await decryptCredential(migration.patch!, "project_a", "authorization"),
    ).toBe("recoverable");
  });

  it("leaves irreconcilable dual ciphertext untouched without plaintext", async () => {
    keyring("v1", { v1: KEY_1 });
    const first = await encryptSecret("first", webhookBinding("project_a"));
    const second = await encryptSecret("second", webhookBinding("project_a"));
    const migration = await migrateStoredSecret(
      {
        ciphertext: first.ciphertext,
        iv: first.iv,
        keyVersion: first.keyVersion,
        sealedCiphertext: second.sealedCiphertext,
        sealedIv: second.sealedIv,
        sealedKeyVersion: second.sealedKeyVersion,
        sealedVersion: second.sealedVersion,
      },
      webhookBinding("project_a"),
    );
    expect(migration).toMatchObject({ broken: true, corrupt: true });
    expect(migration.patch).toBeUndefined();
  });

  it("fails closed on a partial bound envelope without plaintext", async () => {
    keyring("v1", { v1: KEY_1 });
    const encrypted = await encryptSecret(
      "secret",
      webhookBinding("project_a"),
    );
    const partial = { ...encrypted, sealedIv: undefined };
    await expect(
      decryptSecret(partial, webhookBinding("project_a")),
    ).rejects.toThrow("incomplete");
    const migration = await migrateStoredSecret(
      partial,
      webhookBinding("project_a"),
    );
    expect(migration).toMatchObject({
      corrupt: true,
      broken: true,
      recovered: false,
      scrubbed: false,
    });
    expect(migration.patch).toBeUndefined();
  });
});
