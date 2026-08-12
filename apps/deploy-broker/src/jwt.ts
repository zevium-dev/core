import { BrokerError, invariant } from "./errors";
import { isRecord, parseStrictJson } from "./strict-json";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 128 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1_000;
const UNKNOWN_KID_REFRESH_GUARD_MS = 30_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface GitHubOidcClaims {
  actor: string;
  actor_id: string;
  aud: string;
  base_ref?: string;
  environment: string;
  event_name: string;
  exp: number;
  head_ref?: string;
  iat: number;
  iss: string;
  job_workflow_ref: string;
  job_workflow_sha: string;
  jti: string;
  nbf: number;
  ref: string;
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  repository_visibility: string;
  run_attempt: string;
  run_id: string;
  sha: string;
  sub: string;
  workflow_ref: string;
  workflow_sha: string;
}

interface JoseHeader {
  alg: "RS256";
  kid: string;
  typ: "JWT";
}

interface CachedJwks {
  expiresAt: number;
  keys: GitHubJwk[];
}

type GitHubJwk = JsonWebKey & { kid: string };

export interface JwtVerificationOptions {
  cacheJwks?: boolean;
  fetcher?: typeof fetch;
  nowSeconds?: number;
  resolveJwk?: (kid: string, forceRefresh: boolean) => Promise<JsonWebKey>;
}

let memoryJwks: CachedJwks | undefined;
let lastForcedRefreshAt = 0;

function decodeBase64Url(
  value: string,
  label: string,
): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new BrokerError(
      401,
      "invalid_token",
      `${label} is not canonical base64url`,
    );
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new BrokerError(
      401,
      "invalid_token",
      `${label} is not valid base64url`,
    );
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value) {
    throw new BrokerError(
      401,
      "invalid_token",
      `${label} is not canonical base64url`,
    );
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeJsonSegment(segment: string, label: string): unknown {
  const bytes = decodeBase64Url(segment, label);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrokerError(401, "invalid_token", `${label} is not UTF-8`);
  }
  try {
    return parseStrictJson(source);
  } catch (error) {
    if (error instanceof BrokerError) {
      throw new BrokerError(
        401,
        "invalid_token",
        `${label} is not strict JSON`,
      );
    }
    throw error;
  }
}

function parseHeader(value: unknown): JoseHeader {
  invariant(
    isRecord(value),
    401,
    "invalid_token",
    "JWT header must be an object",
  );
  invariant(
    value.alg === "RS256",
    401,
    "invalid_token",
    "JWT alg must be RS256",
  );
  invariant(value.typ === "JWT", 401, "invalid_token", "JWT typ must be JWT");
  invariant(
    typeof value.kid === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.kid),
    401,
    "invalid_token",
    "JWT kid is invalid",
  );
  return { alg: "RS256", kid: value.kid, typ: "JWT" };
}

function requireString(
  value: Record<string, unknown>,
  name: string,
  pattern?: RegExp,
): string {
  const candidate = value[name];
  invariant(
    typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 512,
    401,
    "invalid_claims",
    `OIDC ${name} claim is invalid`,
  );
  invariant(
    !pattern || pattern.test(candidate),
    401,
    "invalid_claims",
    `OIDC ${name} claim is invalid`,
  );
  return candidate;
}

function requireTime(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  invariant(
    typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate > 0,
    401,
    "invalid_claims",
    `OIDC ${name} claim is invalid`,
  );
  return candidate;
}

function parseClaims(value: unknown): GitHubOidcClaims {
  invariant(
    isRecord(value),
    401,
    "invalid_claims",
    "OIDC payload must be an object",
  );
  const optionalString = (name: string): string | undefined => {
    const candidate = value[name];
    if (candidate === undefined) return undefined;
    invariant(
      typeof candidate === "string" && candidate.length <= 512,
      401,
      "invalid_claims",
      `OIDC ${name} claim is invalid`,
    );
    return candidate;
  };
  const baseRef = optionalString("base_ref");
  const headRef = optionalString("head_ref");
  const claims: GitHubOidcClaims = {
    actor: requireString(value, "actor"),
    actor_id: requireString(value, "actor_id", /^[1-9][0-9]{0,19}$/),
    aud: requireString(value, "aud"),
    environment: requireString(value, "environment"),
    event_name: requireString(value, "event_name"),
    exp: requireTime(value, "exp"),
    iat: requireTime(value, "iat"),
    iss: requireString(value, "iss"),
    job_workflow_ref: requireString(value, "job_workflow_ref"),
    job_workflow_sha: requireString(
      value,
      "job_workflow_sha",
      /^[0-9a-f]{40}$/,
    ),
    jti: requireString(value, "jti", /^[A-Za-z0-9._:-]{1,200}$/),
    nbf: requireTime(value, "nbf"),
    ref: requireString(value, "ref"),
    repository: requireString(value, "repository"),
    repository_id: requireString(value, "repository_id", /^[1-9][0-9]{0,19}$/),
    repository_owner: requireString(value, "repository_owner"),
    repository_owner_id: requireString(
      value,
      "repository_owner_id",
      /^[1-9][0-9]{0,19}$/,
    ),
    repository_visibility: requireString(value, "repository_visibility"),
    run_attempt: requireString(value, "run_attempt", /^[1-9][0-9]{0,3}$/),
    run_id: requireString(value, "run_id", /^[1-9][0-9]{0,19}$/),
    sha: requireString(value, "sha", /^[0-9a-f]{40}$/),
    sub: requireString(value, "sub"),
    workflow_ref: requireString(value, "workflow_ref"),
    workflow_sha: requireString(value, "workflow_sha", /^[0-9a-f]{40}$/),
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(headRef === undefined ? {} : { head_ref: headRef }),
  };
  return claims;
}

function validateTimes(claims: GitHubOidcClaims, nowSeconds: number): void {
  invariant(
    claims.exp > nowSeconds,
    401,
    "token_expired",
    "OIDC token expired",
  );
  invariant(
    claims.nbf <= nowSeconds + 30,
    401,
    "token_not_yet_valid",
    "OIDC token is not active",
  );
  invariant(
    claims.iat <= nowSeconds + 30 && claims.iat >= nowSeconds - 120,
    401,
    "stale_token",
    "OIDC token was not issued recently",
  );
  invariant(
    claims.exp > claims.iat && claims.exp - claims.iat <= 600,
    401,
    "invalid_claims",
    "OIDC token lifetime is invalid",
  );
  invariant(
    claims.nbf <= claims.iat + 30,
    401,
    "invalid_claims",
    "OIDC nbf/iat claims are inconsistent",
  );
}

async function parseJwksResponse(response: Response): Promise<GitHubJwk[]> {
  invariant(
    response.status === 200,
    503,
    "jwks_unavailable",
    "GitHub JWKS is unavailable",
  );
  invariant(
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json"),
    503,
    "jwks_unavailable",
    "GitHub JWKS response type is invalid",
  );
  const declaredLength = response.headers.get("content-length");
  invariant(
    declaredLength === null ||
      (/^(?:0|[1-9][0-9]*)$/.test(declaredLength) &&
        Number(declaredLength) <= MAX_JWKS_BYTES),
    503,
    "jwks_unavailable",
    "GitHub JWKS response is too large",
  );
  invariant(
    response.body,
    503,
    "jwks_unavailable",
    "GitHub JWKS response is empty",
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel("JWKS response limit exceeded");
      throw new BrokerError(
        503,
        "jwks_unavailable",
        "GitHub JWKS response is too large",
      );
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document = parseStrictJson(source);
  invariant(
    isRecord(document) && Array.isArray(document.keys),
    503,
    "jwks_unavailable",
    "GitHub JWKS is invalid",
  );
  const keys: GitHubJwk[] = [];
  for (const key of document.keys) {
    if (
      isRecord(key) &&
      key.kty === "RSA" &&
      key.alg === "RS256" &&
      key.use === "sig" &&
      typeof key.kid === "string" &&
      typeof key.n === "string" &&
      typeof key.e === "string"
    ) {
      keys.push(key as unknown as GitHubJwk);
    }
  }
  invariant(
    keys.length > 0 && keys.length <= 16,
    503,
    "jwks_unavailable",
    "GitHub JWKS has no usable keys",
  );
  return keys;
}

async function fetchJwks(
  fetcher: typeof fetch,
  forceRefresh: boolean,
  cacheJwks: boolean,
): Promise<GitHubJwk[]> {
  const now = Date.now();
  if (cacheJwks && !forceRefresh && memoryJwks && memoryJwks.expiresAt > now)
    return memoryJwks.keys;

  let response: Response | undefined;
  const cache =
    !cacheJwks || typeof caches === "undefined"
      ? undefined
      : (caches as unknown as { default: Cache }).default;
  if (!forceRefresh && cache) response = await cache.match(GITHUB_JWKS_URL);
  if (!response) {
    response = await fetcher(GITHUB_JWKS_URL, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    invariant(
      response.status < 300 || response.status >= 400,
      503,
      "jwks_redirect_rejected",
      "GitHub JWKS redirect was rejected",
    );
    if (cache && response.status === 200) {
      const cachedResponse = response.clone();
      const cacheHeaders = new Headers(cachedResponse.headers);
      cacheHeaders.set(
        "cache-control",
        `public, max-age=${Math.floor(JWKS_TTL_MS / 1_000)}`,
      );
      await cache.put(
        GITHUB_JWKS_URL,
        new Response(cachedResponse.body, {
          headers: cacheHeaders,
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
        }),
      );
    }
  }
  const keys = await parseJwksResponse(response);
  if (cacheJwks) {
    memoryJwks = { expiresAt: now + JWKS_TTL_MS, keys };
    if (forceRefresh) lastForcedRefreshAt = now;
  }
  return keys;
}

async function resolveProductionJwk(
  kid: string,
  forceRefresh: boolean,
  fetcher: typeof fetch,
  cacheJwks: boolean,
): Promise<GitHubJwk> {
  if (
    cacheJwks &&
    forceRefresh &&
    Date.now() - lastForcedRefreshAt < UNKNOWN_KID_REFRESH_GUARD_MS
  ) {
    const cached = memoryJwks?.keys.find((candidate) => candidate.kid === kid);
    invariant(
      cached,
      401,
      "unknown_signing_key",
      "OIDC signing key is unknown",
    );
    return cached;
  }
  let keys = await fetchJwks(fetcher, forceRefresh, cacheJwks);
  let key = keys.find((candidate) => candidate.kid === kid);
  if (!key && !forceRefresh) {
    if (
      cacheJwks &&
      Date.now() - lastForcedRefreshAt < UNKNOWN_KID_REFRESH_GUARD_MS
    ) {
      throw new BrokerError(
        401,
        "unknown_signing_key",
        "OIDC signing key is unknown",
      );
    }
    keys = await fetchJwks(fetcher, true, cacheJwks);
    key = keys.find((candidate) => candidate.kid === kid);
  }
  invariant(key, 401, "unknown_signing_key", "OIDC signing key is unknown");
  return key;
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  invariant(
    authorization !== null && authorization.startsWith("Bearer "),
    401,
    "missing_token",
    "Bearer OIDC token is required",
  );
  const token = authorization.slice("Bearer ".length);
  invariant(
    token.length > 0 && token.length <= MAX_TOKEN_BYTES && !/\s/.test(token),
    401,
    "invalid_token",
    "Bearer OIDC token is invalid",
  );
  return token;
}

export async function verifyGitHubOidc(
  token: string,
  expectedAudience: string,
  options: JwtVerificationOptions = {},
): Promise<GitHubOidcClaims> {
  invariant(
    token.length <= MAX_TOKEN_BYTES,
    401,
    "invalid_token",
    "OIDC token is too large",
  );
  const segments = token.split(".");
  invariant(
    segments.length === 3,
    401,
    "invalid_token",
    "OIDC token must have three segments",
  );
  const encodedHeader = segments[0];
  const encodedPayload = segments[1];
  const encodedSignature = segments[2];
  invariant(
    encodedHeader && encodedPayload && encodedSignature,
    401,
    "invalid_token",
    "OIDC token has an empty segment",
  );
  const header = parseHeader(decodeJsonSegment(encodedHeader, "JWT header"));
  const claims = parseClaims(decodeJsonSegment(encodedPayload, "JWT payload"));
  const resolver =
    options.resolveJwk ??
    ((kid: string, forceRefresh: boolean) =>
      resolveProductionJwk(
        kid,
        forceRefresh,
        options.fetcher ?? fetch,
        options.cacheJwks ?? true,
      ));
  let jwk = await resolver(header.kid, false);
  let key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
  const signingInput = Uint8Array.from(
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  const signature = decodeBase64Url(encodedSignature, "JWT signature");
  let valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature.buffer,
    signingInput.buffer,
  );
  if (!valid) {
    jwk = await resolver(header.kid, true);
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer,
      signingInput.buffer,
    );
  }
  invariant(valid, 401, "invalid_signature", "OIDC signature is invalid");
  invariant(
    claims.iss === GITHUB_OIDC_ISSUER,
    401,
    "invalid_issuer",
    "OIDC issuer is invalid",
  );
  invariant(
    claims.aud === expectedAudience,
    401,
    "invalid_audience",
    "OIDC audience is invalid",
  );
  validateTimes(claims, options.nowSeconds ?? Math.floor(Date.now() / 1_000));
  return claims;
}

export function resetJwksCacheForTest(): void {
  memoryJwks = undefined;
  lastForcedRefreshAt = 0;
}
