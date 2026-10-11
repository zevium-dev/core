/** Canonical edge types and protocol helpers. Authority comes from signed snapshots. */

export type VerifiedKey = {
  orgId: string;
  keyId: string;
  scopes: string[];
};

/**
 * Tri-state verification outcome. `invalid` is definitive signed key evidence and
 * is cacheable; `unavailable` covers network failure, 5xx, and malformed
 * responses — never cached, surfaced as 503 so an authority outage does not
 * masquerade as a bad key.
 */
export type VerifyOutcome =
  | { status: "ok"; key: VerifiedKey }
  | { status: "invalid" }
  | { status: "unavailable" };

export interface KeyVerifier {
  verify(secret: string): Promise<VerifiedKey | null>;
  verifyWithStatus?(secret: string): Promise<VerifyOutcome>;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** True for Clerk default `ak_` or future custom `zev_` secrets. */
export function isApiKeySecret(secret: string): boolean {
  return secret.startsWith("ak_") || secret.startsWith("zev_");
}

/** Extract API key from Authorization: Bearer ak_/zev_... or x-api-key. */
export function extractApiKey(request: Request): string | null {
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    const trimmed = xApiKey.trim();
    if (isApiKeySecret(trimmed)) return trimmed;
  }

  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(\S+)/i.exec(auth);
  if (!match) return null;
  const token = match[1]!;
  if (!isApiKeySecret(token)) return null;
  return token;
}

/** In-memory verifier for tests. */
export class FixtureKeyVerifier implements KeyVerifier {
  readonly #keys: Map<string, VerifiedKey>;

  constructor(keys: Record<string, VerifiedKey> = {}) {
    this.#keys = new Map(Object.entries(keys));
  }

  set(secret: string, value: VerifiedKey): void {
    this.#keys.set(secret, value);
  }

  async verify(secret: string): Promise<VerifiedKey | null> {
    return this.#keys.get(secret) ?? null;
  }

  async verifyWithStatus(secret: string): Promise<VerifyOutcome> {
    const key = this.#keys.get(secret);
    return key ? { status: "ok", key } : { status: "invalid" };
  }
}
