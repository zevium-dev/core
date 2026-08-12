const KEYRING_ENV = "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS";
const ENVELOPE_VERSION = "v2" as const;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Keyring = {
  current: string;
  /** Exact configured text used by pre-v2 SHA-256 key derivation. */
  legacyMaterials: Record<string, string>;
  /** Canonical 32-byte values eligible for bound v2 envelopes. */
  rawKeys: Record<string, Uint8Array>;
};

export type SecretBinding = {
  purpose: "upstream-credential" | "webhook-signing-secret";
  resource: string;
};

export type LegacyEncryptedSecret = {
  ciphertext: string;
  iv: string;
  keyVersion: string;
};

export type BoundEncryptedSecret = {
  sealedCiphertext: string;
  sealedIv: string;
  sealedKeyVersion: string;
  sealedVersion: typeof ENVELOPE_VERSION;
};

/**
 * During rollout every write carries both envelopes. `ciphertext` keeps the
 * previous release rollback-safe; `sealed*` is the AAD-bound source of truth.
 */
export type EncryptedSecret = LegacyEncryptedSecret & BoundEncryptedSecret;
export type EncryptedCredential = EncryptedSecret;

export type StoredEncryptedSecret = {
  ciphertext?: string;
  iv?: string;
  keyVersion?: string;
  sealedCiphertext?: string;
  sealedIv?: string;
  sealedKeyVersion?: string;
  sealedVersion?: string;
  /** Transitional plaintext-only source. Never written by current code. */
  secret?: string;
};

export type StoredSecretForMigration = StoredEncryptedSecret;

export type SecretMigrationResult = {
  /** Exact state observed before this row's repair. */
  plaintext: boolean;
  old: boolean;
  corrupt: boolean;
  /** Row had no trustworthy cleartext source and was left untouched. */
  broken: boolean;
  recovered: boolean;
  rewrapped: boolean;
  scrubbed: boolean;
  patch?: EncryptedSecret & { secret: undefined };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function strictKeyMaterial(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Credential encryption keyring is invalid");
  }
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(value);
  } catch {
    throw new Error("Credential encryption keyring is invalid");
  }
  // Reject whitespace, URL-safe aliases, missing padding, and non-256-bit keys.
  if (decoded.byteLength !== 32 || toBase64(decoded) !== value) {
    throw new Error("Credential encryption keyring is invalid");
  }
  return decoded;
}

function keyring(): Keyring {
  const raw = process.env[KEYRING_ENV];
  if (!raw) throw new Error("Credential encryption keyring is not configured");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("current" in parsed) ||
      !("keys" in parsed) ||
      typeof parsed.current !== "string" ||
      !VERSION_ID.test(parsed.current) ||
      parsed.keys === null ||
      typeof parsed.keys !== "object" ||
      Array.isArray(parsed.keys)
    ) {
      throw new Error("invalid shape");
    }

    const legacyMaterials: Record<string, string> = {};
    const rawKeys: Record<string, Uint8Array> = {};
    for (const [version, material] of Object.entries(parsed.keys)) {
      if (!VERSION_ID.test(version)) throw new Error("invalid version");
      if (
        typeof material !== "string" ||
        material.length === 0 ||
        material.length > 8192
      ) {
        throw new Error("invalid key material");
      }
      legacyMaterials[version] = material;
      try {
        rawKeys[version] = strictKeyMaterial(material);
      } catch {
        // Retained arbitrary strings remain valid only for legacy decrypt.
      }
    }
    if (!(parsed.current in legacyMaterials)) {
      throw new Error("missing current key");
    }
    return { current: parsed.current, legacyMaterials, rawKeys };
  } catch {
    throw new Error("Credential encryption keyring is invalid");
  }
}

export function currentCredentialKeyVersion(): string {
  return keyring().current;
}

export type CredentialKeyringPreflight = {
  current: string;
  boundEnvelopeReady: boolean;
  legacyCompatibleVersions: string[];
  legacyOnlyVersions: string[];
};

/** Read-only rollout check. Old arbitrary strings stay decryptable, never writable. */
export function credentialKeyringPreflight(): CredentialKeyringPreflight {
  const ring = keyring();
  const versions = Object.keys(ring.legacyMaterials).sort();
  return {
    current: ring.current,
    boundEnvelopeReady: ring.rawKeys[ring.current] !== undefined,
    legacyCompatibleVersions: versions,
    legacyOnlyVersions: versions.filter(
      (version) => ring.rawKeys[version] === undefined,
    ),
  };
}

async function rawCryptoKey(version: string): Promise<CryptoKey> {
  const material = keyring().rawKeys[version];
  if (!material) {
    throw new Error(
      `Credential encryption key '${version}' is unavailable for bound envelopes`,
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    buffer(material),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

/** Previous releases SHA-256 hashed configured text before AES import. */
async function legacyCryptoKey(version: string): Promise<CryptoKey> {
  const material = keyring().legacyMaterials[version];
  if (!material) {
    throw new Error(`Credential encryption key '${version}' is unavailable`);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(material),
  );
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function aad(binding: SecretBinding, keyVersion: string): Uint8Array {
  if (binding.resource.length === 0) {
    throw new Error("Credential encryption resource binding is required");
  }
  return encoder.encode(
    `zevium-secret\u0000${ENVELOPE_VERSION}\u0000${binding.purpose}\u0000${binding.resource}\u0000${keyVersion}`,
  );
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function encryptWithKey(
  secret: string,
  key: CryptoKey,
  additionalData?: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      ...(additionalData ? { additionalData } : {}),
    },
    key,
    encoder.encode(secret),
  );
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

async function decryptWithKey(
  ciphertextValue: string,
  ivValue: string,
  key: CryptoKey,
  additionalData?: Uint8Array,
): Promise<string> {
  const iv = fromBase64(ivValue);
  if (iv.byteLength !== 12) throw new Error("invalid iv");
  const ciphertext = fromBase64(ciphertextValue);
  const cleartext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buffer(iv),
      ...(additionalData ? { additionalData } : {}),
    },
    key,
    buffer(ciphertext),
  );
  return decoder.decode(cleartext);
}

export function credentialBinding(
  projectId: string,
  name: string,
): SecretBinding {
  return {
    purpose: "upstream-credential",
    resource: `${projectId}:${name}`,
  };
}

export function webhookBinding(projectId: string): SecretBinding {
  return { purpose: "webhook-signing-secret", resource: projectId };
}

export function hasLegacyEnvelope(
  input: StoredEncryptedSecret,
): input is LegacyEncryptedSecret {
  return (
    typeof input.ciphertext === "string" &&
    input.ciphertext.length > 0 &&
    typeof input.iv === "string" &&
    input.iv.length > 0 &&
    typeof input.keyVersion === "string" &&
    input.keyVersion.length > 0
  );
}

export function hasBoundEnvelope(
  input: StoredEncryptedSecret,
): input is BoundEncryptedSecret {
  return (
    input.sealedVersion === ENVELOPE_VERSION &&
    typeof input.sealedCiphertext === "string" &&
    input.sealedCiphertext.length > 0 &&
    typeof input.sealedIv === "string" &&
    input.sealedIv.length > 0 &&
    typeof input.sealedKeyVersion === "string" &&
    input.sealedKeyVersion.length > 0
  );
}

export function requireEncryptedSecret(
  input: StoredEncryptedSecret,
): StoredEncryptedSecret {
  const legacyComplete = hasLegacyEnvelope(input);
  const boundComplete = hasBoundEnvelope(input);
  if (
    (hasAnyLegacyField(input) && !legacyComplete) ||
    (hasAnyBoundField(input) && !boundComplete)
  ) {
    throw new Error("Stored secret envelope is incomplete");
  }
  if (!boundComplete && !legacyComplete && typeof input.secret !== "string") {
    throw new Error("Stored secret is pending encryption migration");
  }
  return input;
}

export function requireEncryptedCredential(
  input: StoredEncryptedSecret,
): StoredEncryptedSecret {
  try {
    return requireEncryptedSecret(input);
  } catch {
    throw new Error(
      "Stored upstream credential is pending encryption migration",
    );
  }
}

export async function encryptSecret(
  secret: string,
  binding: SecretBinding,
): Promise<EncryptedSecret> {
  const keyVersion = keyring().current;
  const [legacy, sealed] = await Promise.all([
    encryptWithKey(secret, await legacyCryptoKey(keyVersion)),
    encryptWithKey(
      secret,
      await rawCryptoKey(keyVersion),
      aad(binding, keyVersion),
    ),
  ]);
  const encrypted: EncryptedSecret = {
    ciphertext: legacy.ciphertext,
    iv: legacy.iv,
    keyVersion,
    sealedCiphertext: sealed.ciphertext,
    sealedIv: sealed.iv,
    sealedKeyVersion: keyVersion,
    sealedVersion: ENVELOPE_VERSION,
  };
  await verifyDualSecret(encrypted, binding, secret);
  return encrypted;
}

export async function decryptLegacySecret(
  input: LegacyEncryptedSecret,
): Promise<string> {
  try {
    return await decryptWithKey(
      input.ciphertext,
      input.iv,
      await legacyCryptoKey(input.keyVersion),
    );
  } catch {
    throw new Error("Stored secret cannot be decrypted");
  }
}

export async function decryptBoundSecret(
  input: BoundEncryptedSecret,
  binding: SecretBinding,
): Promise<string> {
  try {
    return await decryptWithKey(
      input.sealedCiphertext,
      input.sealedIv,
      await rawCryptoKey(input.sealedKeyVersion),
      aad(binding, input.sealedKeyVersion),
    );
  } catch {
    throw new Error("Stored secret cannot be decrypted");
  }
}

/** Prefer bound v2, retain legacy read during staged rollout. */
export async function decryptSecret(
  input: StoredEncryptedSecret,
  binding: SecretBinding,
): Promise<string> {
  requireEncryptedSecret(input);
  const values: string[] = [];
  if (hasLegacyEnvelope(input)) {
    values.push(await decryptLegacySecret(input));
  }
  if (hasBoundEnvelope(input)) {
    values.push(await decryptBoundSecret(input, binding));
  }
  if (typeof input.secret === "string") values.push(input.secret);
  if (values.length === 0 || values.some((value) => value !== values[0])) {
    throw new Error("Stored secret cannot be decrypted");
  }
  return values[0]!;
}

/** Verify both rollback and bound envelopes before any recoverable copy is scrubbed. */
export async function verifyDualSecret(
  input: EncryptedSecret,
  binding: SecretBinding,
  expected: string,
): Promise<void> {
  const [legacy, sealed] = await Promise.all([
    decryptLegacySecret(input),
    decryptBoundSecret(input, binding),
  ]);
  if (legacy !== expected || sealed !== expected) {
    throw new Error("Credential encryption read-back verification failed");
  }
}

function hasAnyLegacyField(input: StoredEncryptedSecret): boolean {
  return (
    input.ciphertext !== undefined ||
    input.iv !== undefined ||
    input.keyVersion !== undefined
  );
}

function hasAnyBoundField(input: StoredEncryptedSecret): boolean {
  return (
    input.sealedCiphertext !== undefined ||
    input.sealedIv !== undefined ||
    input.sealedKeyVersion !== undefined ||
    input.sealedVersion !== undefined
  );
}

/**
 * Repair one rollout row. Hybrid plaintext is authoritative only after every
 * decryptable envelope is compared with it. A newly written dual envelope is
 * decrypted twice before the caller receives a patch that removes plaintext.
 */
export async function migrateStoredSecret(
  input: StoredSecretForMigration,
  binding: SecretBinding,
): Promise<SecretMigrationResult> {
  const current = keyring().current;
  const plaintext = input.secret !== undefined;
  const legacyComplete = hasLegacyEnvelope(input);
  const boundComplete = hasBoundEnvelope(input);
  const legacyPartial = hasAnyLegacyField(input) && !legacyComplete;
  const boundPartial = hasAnyBoundField(input) && !boundComplete;

  let legacyValue: string | undefined;
  let boundValue: string | undefined;
  let corrupt = legacyPartial || boundPartial;
  if (legacyComplete) {
    try {
      legacyValue = await decryptLegacySecret(input);
    } catch {
      corrupt = true;
    }
  }
  if (boundComplete) {
    try {
      boundValue = await decryptBoundSecret(input, binding);
    } catch {
      corrupt = true;
    }
  }

  if (
    legacyValue !== undefined &&
    boundValue !== undefined &&
    legacyValue !== boundValue
  ) {
    corrupt = true;
  }
  if (
    input.secret !== undefined &&
    ((legacyValue !== undefined && legacyValue !== input.secret) ||
      (boundValue !== undefined && boundValue !== input.secret))
  ) {
    corrupt = true;
  }

  // Partial envelopes are tamper evidence. Without independent plaintext,
  // never trust the other envelope as authority or silently downgrade it.
  if ((legacyPartial || boundPartial) && input.secret === undefined) {
    return {
      plaintext,
      old: true,
      corrupt: true,
      broken: true,
      recovered: false,
      rewrapped: false,
      scrubbed: false,
    };
  }

  const canonical = input.secret ?? boundValue ?? legacyValue;
  const irreconcilableDual =
    input.secret === undefined &&
    legacyValue !== undefined &&
    boundValue !== undefined &&
    legacyValue !== boundValue;
  if (canonical === undefined || irreconcilableDual) {
    return {
      plaintext,
      old: true,
      corrupt,
      broken: true,
      recovered: false,
      rewrapped: false,
      scrubbed: false,
    };
  }

  const old =
    !legacyComplete ||
    !boundComplete ||
    input.keyVersion !== current ||
    input.sealedKeyVersion !== current;
  const valuesMatch =
    legacyValue === canonical && boundValue === canonical && !corrupt;
  if (!plaintext && !old && valuesMatch) {
    return {
      plaintext: false,
      old: false,
      corrupt: false,
      broken: false,
      recovered: false,
      rewrapped: false,
      scrubbed: false,
    };
  }

  // Always replace both envelopes when repairing. This also makes the legacy
  // rollback copy current-key encrypted before old key retirement.
  const encrypted = await encryptSecret(canonical, binding);
  await verifyDualSecret(encrypted, binding, canonical);
  return {
    plaintext,
    old,
    corrupt,
    broken: false,
    recovered: corrupt,
    rewrapped: old && !plaintext,
    scrubbed: plaintext,
    patch: { ...encrypted, secret: undefined },
  };
}

export async function encryptCredential(
  secret: string,
  projectId: string,
  name: string,
): Promise<EncryptedCredential> {
  return await encryptSecret(secret, credentialBinding(projectId, name));
}

export async function decryptCredential(
  input: StoredEncryptedSecret,
  projectId: string,
  name: string,
): Promise<string> {
  try {
    return await decryptSecret(input, credentialBinding(projectId, name));
  } catch {
    throw new Error("Stored upstream credential cannot be decrypted");
  }
}
