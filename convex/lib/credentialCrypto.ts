const KEYRING_ENV = "UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS";

type Keyring = { current: string; keys: Record<string, string> };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function keyring(): Keyring {
  const raw = process.env[KEYRING_ENV];
  if (!raw) throw new Error("Credential encryption keyring is not configured");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "current" in parsed &&
      "keys" in parsed &&
      typeof parsed.current === "string" &&
      parsed.keys !== null &&
      typeof parsed.keys === "object" &&
      !Array.isArray(parsed.keys) &&
      typeof (parsed.keys as Record<string, unknown>)[parsed.current] ===
        "string"
    ) {
      return parsed as Keyring;
    }
  } catch {
    // Fall through to the safe configuration error.
  }
  throw new Error("Credential encryption keyring is invalid");
}

async function cryptoKey(keyId: string): Promise<CryptoKey> {
  const material = keyring().keys[keyId];
  if (!material)
    throw new Error(`Credential encryption key '${keyId}' is unavailable`);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  keyVersion: string;
};

export type EncryptedCredential = EncryptedSecret;

export function requireEncryptedSecret(input: {
  ciphertext?: string;
  iv?: string;
  keyVersion?: string;
}): EncryptedSecret {
  if (!input.ciphertext || !input.iv || !input.keyVersion) {
    throw new Error("Stored secret is pending encryption migration");
  }
  return {
    ciphertext: input.ciphertext,
    iv: input.iv,
    keyVersion: input.keyVersion,
  };
}

export function requireEncryptedCredential(input: {
  ciphertext?: string;
  iv?: string;
  keyVersion?: string;
}): EncryptedCredential {
  try {
    return requireEncryptedSecret(input);
  } catch {
    throw new Error(
      "Stored upstream credential is pending encryption migration",
    );
  }
}

export async function encryptSecret(secret: string): Promise<EncryptedSecret> {
  const keyVersion = keyring().current;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cryptoKey(keyVersion),
    new TextEncoder().encode(secret),
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
    keyVersion,
  };
}

export async function decryptSecret(input: EncryptedSecret): Promise<string> {
  try {
    const iv = fromBase64(input.iv);
    const ciphertext = fromBase64(input.ciphertext);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv.buffer.slice(
          iv.byteOffset,
          iv.byteOffset + iv.byteLength,
        ) as ArrayBuffer,
      },
      await cryptoKey(input.keyVersion),
      ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength,
      ) as ArrayBuffer,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Stored secret cannot be decrypted");
  }
}

export async function encryptCredential(
  secret: string,
): Promise<EncryptedCredential> {
  return await encryptSecret(secret);
}

export async function decryptCredential(
  input: EncryptedCredential,
): Promise<string> {
  try {
    return await decryptSecret(input);
  } catch {
    throw new Error("Stored upstream credential cannot be decrypted");
  }
}
