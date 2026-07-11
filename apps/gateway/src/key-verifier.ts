/**
 * API key verification with per-isolate memory + Cache API (TTL 60s).
 * Hot path never waits on Clerk when cache hits.
 */

export type VerifiedKey = {
  orgId: string;
  keyId: string;
  scopes: string[];
};

export interface KeyVerifier {
  verify(secret: string): Promise<VerifiedKey | null>;
}

export type ClerkVerifyEnv = {
  CLERK_SECRET_KEY: string;
};

const CACHE_TTL_SECONDS = 60;
const CACHE_NAME = "zevium-api-key-verify-v1";
const MEMORY_MAX = 512;

type MemoryEntry = {
  value: VerifiedKey | null;
  expiresAt: number;
};

export type ClerkKeyVerifierOptions = {
  secretKey: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock for tests. */
  now?: () => number;
  /** Override Cache API (tests can pass a Map-backed fake). */
  caches?: CacheStorage | null;
  /** Disable Cache API entirely (memory only). */
  useCacheApi?: boolean;
  clerkVerifyUrl?: string;
};

/**
 * Clerk Machine API Keys verify:
 * POST https://api.clerk.com/v1/api_keys/verify
 * Authorization: Bearer <CLERK_SECRET_KEY>
 * body: { secret: "ak_..." | "zev_..." }
 */
export class ClerkKeyVerifier implements KeyVerifier {
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #useCacheApi: boolean;
  readonly #caches: CacheStorage | null;
  readonly #verifyUrl: string;
  readonly #memory = new Map<string, MemoryEntry>();

  constructor(opts: ClerkKeyVerifierOptions) {
    this.#secretKey = opts.secretKey;
    // workerd fetch is not free-callable; bind or wrap so stored ref keeps `this`.
    this.#fetch =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
    this.#useCacheApi = opts.useCacheApi !== false;
    this.#caches =
      opts.caches === undefined
        ? typeof caches !== "undefined"
          ? caches
          : null
        : opts.caches;
    this.#verifyUrl =
      opts.clerkVerifyUrl ?? "https://api.clerk.com/v1/api_keys/verify";
  }

  async verify(secret: string): Promise<VerifiedKey | null> {
    if (!secret || !isApiKeySecret(secret)) return null;

    const cacheKey = await sha256Hex(secret);
    const now = this.#now();

    const mem = this.#memory.get(cacheKey);
    if (mem && mem.expiresAt > now) {
      return mem.value;
    }

    if (this.#useCacheApi && this.#caches) {
      const cached = await this.#readCacheApi(cacheKey);
      if (cached !== undefined) {
        this.#writeMemory(cacheKey, cached, now);
        return cached;
      }
    }

    const verified = await this.#verifyRemote(secret);
    this.#writeMemory(cacheKey, verified, now);
    if (this.#useCacheApi && this.#caches) {
      // Fire-and-forget cache fill; failures must not break verify.
      void this.#writeCacheApi(cacheKey, verified);
    }
    return verified;
  }

  #writeMemory(cacheKey: string, value: VerifiedKey | null, now: number): void {
    if (this.#memory.size >= MEMORY_MAX) {
      // Drop oldest insertion (Map preserves order).
      const first = this.#memory.keys().next().value;
      if (first !== undefined) this.#memory.delete(first);
    }
    this.#memory.set(cacheKey, {
      value,
      expiresAt: now + CACHE_TTL_SECONDS * 1000,
    });
  }

  async #readCacheApi(
    cacheKey: string,
  ): Promise<VerifiedKey | null | undefined> {
    try {
      const cache = await this.#caches!.open(CACHE_NAME);
      const req = cacheRequest(cacheKey);
      const res = await cache.match(req);
      if (!res) return undefined;
      const json: unknown = await res.json();
      return parseCachedVerified(json);
    } catch {
      return undefined;
    }
  }

  async #writeCacheApi(
    cacheKey: string,
    value: VerifiedKey | null,
  ): Promise<void> {
    try {
      const cache = await this.#caches!.open(CACHE_NAME);
      const body = JSON.stringify({ v: 1, value });
      const res = new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      await cache.put(cacheRequest(cacheKey), res);
    } catch {
      // ignore
    }
  }

  async #verifyRemote(secret: string): Promise<VerifiedKey | null> {
    let res: Response;
    try {
      res = await this.#fetch(this.#verifyUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ secret }),
      });
    } catch {
      return null;
    }

    if (!res.ok) return null;

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    return parseClerkVerifyResponse(json);
  }
}

function cacheRequest(cacheKey: string): Request {
  // Cache API keys on absolute URLs; use a synthetic origin.
  return new Request(`https://key-cache.zevium.internal/${cacheKey}`, {
    method: "GET",
  });
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

function parseCachedVerified(json: unknown): VerifiedKey | null | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (!("value" in json)) return undefined;
  const value = json.value;
  if (value === null) return null;
  return parseVerifiedKey(value) ?? undefined;
}

/**
 * Clerk verify response (subset). Fields observed in spike:
 * subject (org_/user_), claims.org_id (user-subject keys), id / api_key_id, scopes, revoked, expiration.
 * orgId prefers claims.org_id when present so user-subject keys route to org wallet.
 */
export function parseClerkVerifyResponse(json: unknown): VerifiedKey | null {
  if (!json || typeof json !== "object") return null;

  // Reject revoked / expired when present
  if ("revoked" in json && json.revoked === true) return null;
  if ("expired" in json && json.expired === true) return null;

  const subject =
    "subject" in json && typeof json.subject === "string" ? json.subject : null;
  if (!subject) return null;

  let claimOrgId: string | null = null;
  if ("claims" in json && json.claims && typeof json.claims === "object") {
    const claims = json.claims as Record<string, unknown>;
    if (typeof claims.org_id === "string" && claims.org_id.length > 0) {
      claimOrgId = claims.org_id;
    }
  }
  const orgId = claimOrgId ?? subject;

  let keyId: string | null = null;
  if ("id" in json && typeof json.id === "string") keyId = json.id;
  else if ("api_key_id" in json && typeof json.api_key_id === "string")
    keyId = json.api_key_id;
  else if ("apiKeyId" in json && typeof json.apiKeyId === "string")
    keyId = json.apiKeyId;
  if (!keyId) return null;

  const scopes: string[] = [];
  if ("scopes" in json && Array.isArray(json.scopes)) {
    for (const s of json.scopes) {
      if (typeof s === "string") scopes.push(s);
    }
  }

  return { orgId, keyId, scopes };
}

function parseVerifiedKey(value: unknown): VerifiedKey | null {
  if (!value || typeof value !== "object") return null;
  if (!("orgId" in value) || typeof value.orgId !== "string") return null;
  if (!("keyId" in value) || typeof value.keyId !== "string") return null;
  const scopes: string[] = [];
  if ("scopes" in value && Array.isArray(value.scopes)) {
    for (const s of value.scopes) {
      if (typeof s === "string") scopes.push(s);
    }
  }
  return { orgId: value.orgId, keyId: value.keyId, scopes };
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
}
