import { Exception } from "@boi.gg/exception";

import { serverEnv } from "~/env/server";

interface KeyRecord {
  id: string;
  key: CryptoKey;
}

interface PrimaryKeyNotFoundMeta {
  [key: string]: unknown;
  availableKeyIds: Array<string>;
  primaryKeyId: string;
}
const PrimaryKeyNotFoundError = Exception.kind<PrimaryKeyNotFoundMeta>("PrimaryKeyNotFoundError");

interface InvalidKeyBytesMeta {
  [key: string]: unknown;
  actualBytes: number;
  expectedBytes: number;
  keyId: string;
}
const InvalidKeyBytesError = Exception.kind<InvalidKeyBytesMeta>("InvalidKeyBytesError");

interface DuplicateKeyMeta {
  [key: string]: unknown;
  keyId: string;
}
const DuplicateKeyError = Exception.kind<DuplicateKeyMeta>("DuplicateKeyError");

let keyRingCache: {
  keysById: Partial<Record<string, KeyRecord>>;
  primaryKeyId: string;
} | null = null;

/**
 * Clears the key ring cache (useful for testing or key rotation).
 */
export function clearKeyRingCache(): void {
  keyRingCache = null;
}

/**
 * Gets all available key IDs (for debugging/admin purposes).
 */
export async function getAllKeyIds(): Promise<Array<string>> {
  const { keysById } = await getKeyRing();
  return Object.keys(keysById);
}

/**
 * Gets a key by its ID, for decryption of existing secrets.
 */
export async function getKeyById(id: string): Promise<KeyRecord | undefined> {
  const { keysById } = await getKeyRing();
  return keysById[id];
}

/**
 * Gets the initialized key ring, initializing it on first call.
 * Uses module-level caching to avoid re-importing keys on every request.
 */
export async function getKeyRing(): Promise<{
  keysById: Partial<Record<string, KeyRecord>>;
  primaryKeyId: string;
}> {
  keyRingCache ??= await initializeKeyRing();
  return keyRingCache;
}

/**
 * Gets the primary key used for new encryptions.
 */
export async function getPrimaryKey(): Promise<KeyRecord> {
  const { keysById, primaryKeyId } = await getKeyRing();
  const key = keysById[primaryKeyId];
  if (!key) {
    throw new PrimaryKeyNotFoundError("Primary key not found", {
      availableKeyIds: Object.keys(keysById),
      primaryKeyId,
    });
  }
  return key;
}

/**
 * Parses and validates the key ring from environment variables.
 * Keys are imported as CryptoKey objects for AES-GCM-256.
 * The SECRETS_KEYS_JSON is already validated and parsed by arktype.
 */
async function initializeKeyRing(): Promise<{
  keysById: Partial<Record<string, KeyRecord>>;
  primaryKeyId: string;
}> {
  const primaryKeyId = serverEnv.SECRETS_PRIMARY_KEY_ID;
  const keyEntries = serverEnv.SECRETS_KEYS_JSON;

  const keysById: Partial<Record<string, KeyRecord>> = {};
  const seenIds = new Set<string>();

  for (const entry of keyEntries) {
    if (seenIds.has(entry.id)) {
      const error = new Error(`Key '${entry.id}' appears multiple times`);
      throw new DuplicateKeyError(`Duplicate key ID: ${entry.id}`, { keyId: entry.id }, error);
    }
    seenIds.add(entry.id);

    // Decode base64 key and validate length (32 bytes for AES-256)
    const keyBytes = Uint8Array.from(atob(entry.key), (c) => c.charCodeAt(0));
    if (keyBytes.length !== 32) {
      const error = new Error(`Key '${entry.id}' is ${keyBytes.length} bytes, expected 32 bytes`);
      throw new InvalidKeyBytesError(
        `Key '${entry.id}' must be 32 bytes`,
        { actualBytes: keyBytes.length, expectedBytes: 32, keyId: entry.id },
        error,
      );
    }

    // Import as CryptoKey for AES-GCM
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);

    keysById[entry.id] = { id: entry.id, key: cryptoKey };
  }

  const primaryKey = keysById[primaryKeyId];
  if (!primaryKey) {
    const error = new Error(
      `Primary key '${primaryKeyId}' not found. Available keys: ${Object.keys(keysById).join(", ")}`,
    );
    throw new PrimaryKeyNotFoundError(
      `SECRETS_PRIMARY_KEY_ID '${primaryKeyId}' not found in SECRETS_KEYS_JSON`,
      { availableKeyIds: Object.keys(keysById), primaryKeyId },
      error,
    );
  }

  return { keysById, primaryKeyId };
}
