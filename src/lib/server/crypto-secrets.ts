import { Exception } from "@boi.gg/exception";

import { getKeyById, getPrimaryKey } from "./secrets-keyring";

interface DecryptErrorMeta {
  [key: string]: unknown;
  reason?: string;
}
const DecryptError = Exception.kind<DecryptErrorMeta>("DecryptError");

interface UnknownEncryptionKeyMeta {
  [key: string]: unknown;
  keyId: string;
}
const UnknownEncryptionKeyError = Exception.kind<UnknownEncryptionKeyMeta>("UnknownEncryptionKeyError");

type InvalidSecretFormatMeta = Record<string, unknown>;
const InvalidSecretFormatError = Exception.kind<InvalidSecretFormatMeta>("InvalidSecretFormatError");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Decrypts a secret that was encrypted with `encryptSecret`.
 *
 * Expects input in format: `keyId:base64(iv):base64(ciphertext)`
 *
 * Looks up the correct key from the key ring based on the keyId,
 * allowing secrets encrypted with older keys to still be decrypted.
 *
 * @throws Error if the key ID is unknown or decryption fails
 */
export async function decryptSecret(encoded: string): Promise<string> {
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new InvalidSecretFormatError("Failed to decrypt secret");
  }

  const [keyId, ivB64, ctB64] = parts;

  // Look up the key used for encryption
  const keyRecord = await getKeyById(keyId);
  if (!keyRecord) {
    throw new UnknownEncryptionKeyError("Failed to decrypt secret", { keyId });
  }

  try {
    // Decode IV and ciphertext from base64
    const ivBinary = atob(ivB64);
    const iv = new Uint8Array(ivBinary.length);
    for (let i = 0; i < ivBinary.length; i++) {
      iv[i] = ivBinary.charCodeAt(i);
    }

    const ctBinary = atob(ctB64);
    const ciphertext = new Uint8Array(ctBinary.length);
    for (let i = 0; i < ctBinary.length; i++) {
      ciphertext[i] = ctBinary.charCodeAt(i);
    }

    // Decrypt - copy to new ArrayBuffer to satisfy TypeScript
    const plaintextBuf = await crypto.subtle.decrypt(
      { iv: iv.buffer.slice(0), name: "AES-GCM" },
      keyRecord.key,
      ciphertext.buffer.slice(0),
    );

    return decoder.decode(plaintextBuf);
  } catch (error) {
    // Don't leak details about why decryption failed
    throw new DecryptError(
      "Failed to decrypt secret",
      { reason: error instanceof Error ? error.message : String(error) },
      error as Error | string,
    );
  }
}

/**
 * Encrypts a plaintext secret using AES-GCM-256.
 *
 * Returns a string in format: `keyId:base64(iv):base64(ciphertext)`
 *
 * The key ID is included so we know which key to use for decryption,
 * enabling key rotation without breaking existing secrets.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  const { id: keyId, key } = await getPrimaryKey();

  // Generate a random 12-byte IV (recommended for AES-GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt the plaintext
  const ciphertextBuf = await crypto.subtle.encrypt({ iv, name: "AES-GCM" }, key, encoder.encode(plaintext));

  // Encode IV and ciphertext as base64
  let ivBinary = "";
  for (const byte of iv) {
    ivBinary += String.fromCharCode(byte);
  }
  const ivB64 = btoa(ivBinary);

  const ctBytes = new Uint8Array(ciphertextBuf);
  let ctBinary = "";
  for (const byte of ctBytes) {
    ctBinary += String.fromCharCode(byte);
  }
  const ctB64 = btoa(ctBinary);

  // Return in format: keyId:iv:ciphertext
  return `${keyId}:${ivB64}:${ctB64}`;
}

/**
 * Extracts the key ID from an encrypted secret without decrypting it.
 * Useful for identifying which secrets need re-encryption during key rotation.
 */
export function getSecretKeyId(encoded: string): null | string {
  const colonIndex = encoded.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  return encoded.substring(0, colonIndex);
}

/**
 * Re-encrypts a secret with the current primary key.
 * Useful for key rotation: decrypt with old key, re-encrypt with new key.
 *
 * @param encoded - The existing encrypted secret
 * @returns The secret encrypted with the current primary key
 */
export async function reencryptSecret(encoded: string): Promise<string> {
  const plaintext = await decryptSecret(encoded);
  return encryptSecret(plaintext);
}

export { DecryptError, InvalidSecretFormatError, UnknownEncryptionKeyError };
