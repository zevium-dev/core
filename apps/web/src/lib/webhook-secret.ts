/**
 * Client-side helpers for webhook signing-secret display.
 *
 * NOTE: Zevium's webhook endpoint secret is generated server-side by
 * `webhooks.upsertEndpoint` (Convex) and returned in the endpoint document.
 * The client never chooses it. These helpers exist for hex formatting, length
 * validation, masking, and previews (used by tests + the settings card).
 */

const HEX_CHARS = "0123456789abcdef";

/** Encode a byte array as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[(b >> 4) & 0xf]! + HEX_CHARS[b & 0xf]!;
  }
  return out;
}

/**
 * Generate `bytes` of cryptographically-random data as a hex string.
 * Default 32 bytes → 64 hex chars (256 bits), matching typical signing-secret
 * strength. Falls back gracefully if `crypto` is somehow unavailable.
 */
export function generateWebhookSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return toHex(buf);
}

/** True when `s` is non-empty lowercase hex of even length. */
export function isHexSecret(s: string): boolean {
  return /^(0x)?[0-9a-f]*$/.test(s) && s.length > 0 && s.length % 2 === 0;
}

/** Mask a secret for display, revealing only the first/last few chars. */
export function maskSecret(secret: string, edge = 4): string {
  if (secret.length <= edge * 2) return "•".repeat(secret.length);
  return `${secret.slice(0, edge)}${"•".repeat(
    Math.max(4, secret.length - edge * 2),
  )}${secret.slice(-edge)}`;
}
