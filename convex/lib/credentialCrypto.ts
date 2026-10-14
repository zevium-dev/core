import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc } from "../_generated/dataModel";
type Envelope = Doc<"upstreamCredentials">["envelope"];
export type SecretBinding = {
  purpose:
    "upstream-credential" | "webhook-signing-secret" | "oauth-connection";
  resource: string;
  generation: number;
};
const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function decode(value: string) {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (b64(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}
function keyring() {
  try {
    const ring = z
      .object({
        current: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        keys: z.record(z.string(), z.string()),
      })
      .strict()
      .parse(
        JSON.parse(process.env.UPSTREAM_CREDENTIAL_ENCRYPTION_KEYS ?? "null"),
      );
    if (!Object.hasOwn(ring.keys, ring.current))
      throw new Error("Missing current key");
    for (const [version, value] of Object.entries(ring.keys))
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) ||
        decode(value).length !== 32
      )
        throw new Error("Invalid key");
    return ring;
  } catch {
    throw new ConvexError("Credential encryption is not configured");
  }
}
function aad(binding: SecretBinding, version: string) {
  if (
    !binding.resource ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1
  )
    throw new Error("Invalid secret binding");
  return encoder.encode(
    JSON.stringify([
      "zevium-secret",
      "aes-gcm-aad-v1",
      binding.purpose,
      binding.resource,
      binding.generation,
      version,
    ]),
  );
}
export function credentialBinding(
  projectId: string,
  name: string,
  generation: number,
): SecretBinding {
  return {
    purpose: "upstream-credential",
    resource: `${projectId}:${name}`,
    generation,
  };
}
export async function encryptSecret(
  secret: string,
  binding: SecretBinding,
): Promise<Envelope> {
  const ring = keyring();
  const key = await crypto.subtle.importKey(
    "raw",
    decode(ring.keys[ring.current]!),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(binding, ring.current) },
    key,
    encoder.encode(secret),
  );
  return {
    format: "aes-gcm-aad-v1",
    keyVersion: ring.current,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  };
}
export async function decryptSecret(
  envelope: Envelope,
  binding: SecretBinding,
): Promise<string> {
  try {
    const ring = keyring();
    if (
      envelope.format !== "aes-gcm-aad-v1" ||
      !Object.hasOwn(ring.keys, envelope.keyVersion)
    )
      throw new Error("Invalid envelope");
    const iv = decode(envelope.iv);
    if (iv.length !== 12) throw new Error("Invalid IV");
    const key = await crypto.subtle.importKey(
      "raw",
      decode(ring.keys[envelope.keyVersion]!),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad(binding, envelope.keyVersion),
      },
      key,
      decode(envelope.ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new ConvexError("Stored credential is unavailable");
  }
}

/** Connection secrets, bound to the connection and field (no swapping). */
export function connectionSecretBinding(
  connectionId: string,
  field: "access" | "refresh" | "verifier",
): SecretBinding {
  return {
    purpose: "oauth-connection",
    resource: `${connectionId}:${field}`,
    generation: 1,
  };
}

export function webhookBinding(
  projectId: string,
  generation: number,
): SecretBinding {
  return { purpose: "webhook-signing-secret", resource: projectId, generation };
}
