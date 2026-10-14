/**
 * Connected accounts: a consumer's own account at a provider Zevium is a
 * registered OAuth client of (see `oauth-providers.ts`), used on their calls.
 *
 * The publisher's OpenAPI spec names the provider: an `oauth2` security scheme
 * with an `authorizationCode` flow and `x-zevium-oauth-provider`, referenced
 * from an operation's effective `security`, makes that operation run with the
 * consumer's connected token. Endpoints and client credentials always come
 * from Zevium's registry, never from the spec.
 */

import type { OpenApiOperation, ParsedOpenApiSpec } from "./openapi.js";
import {
  getOAuthProvider,
  isProviderApiHost,
  type OAuthProvider,
  type OAuthProviderId,
} from "./oauth-providers.js";

/**
 * Request header that selects a connection (stripped before the upstream);
 * also the response header naming the connection a call used.
 */
export const CONNECTION_HEADER = "x-zevium-connection";
/** Fixed path, on the gateway origin, providers redirect back to. */
export const CONNECTION_CALLBACK_PATH = "/connections/callback";
/** Pending authorizations expire quickly; the link is a bearer capability. */
export const CONNECTION_PENDING_TTL_MS = 10 * 60 * 1000;
/** Spec extension on an `oauth2` scheme naming a Zevium OAuth provider. */
export const OAUTH_PROVIDER_EXTENSION = "x-zevium-oauth-provider";
export const MAX_CONNECTION_LABEL_LENGTH = 64;
export const MAX_OAUTH_SCHEMES = 4;
export const MAX_TOKEN_LENGTH = 8192;

const CONNECTION_ID_RE = /^conn_[a-z2-7]{26}$/;
const SCHEME_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LABEL_RE = /^[\x20-\x7E]+$/;

export type ConnectionStatus =
  "pending" | "active" | "reauthorize" | "failed" | "revoked";

/** Public shape returned by the gateway connection API. */
export type ConnectionView = {
  id: string;
  /** `publisherHandle/projectSlug` of the API the connection is for. */
  api: string;
  scheme: string;
  /** Provider id, e.g. `youtube`. */
  provider: string;
  label: string | null;
  status: ConnectionStatus | "expired";
  scopes: string[];
  createdAt: number;
  connectedAt: number | null;
  /** Human-readable reason for `failed` or `reauthorize`. */
  error: string | null;
};

/** Outcome reasons the gateway turns into errors (never a charge). */
export type ConnectionTokenFailure =
  | "connection_required"
  | "connection_ambiguous"
  | "connection_not_found"
  | "connection_reauthorize";

/** A spec security scheme bound to a Zevium OAuth provider. */
export type ConnectedAccountScheme = {
  name: string;
  provider: OAuthProviderId;
  /** Scopes the scheme declares (keys of `scopes`), all allowed by the provider. */
  scopes: string[];
};

export type ConnectionRequirement = {
  scheme: string;
  provider: OAuthProviderId;
  /** Scopes the operation's security requirement lists. */
  scopes: string[];
  /** False when another security alternative needs no connection. */
  required: boolean;
};

export type OAuthSchemeIssue = { path: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_RE.test(value);
}

/** Trimmed printable label up to 64 chars, `null` when absent, `false` if invalid. */
export function normalizeConnectionLabel(
  value: unknown,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const label = value.trim();
  if (label.length === 0) return null;
  if (label.length > MAX_CONNECTION_LABEL_LENGTH || !LABEL_RE.test(label)) {
    return false;
  }
  return label;
}

export function isSchemeName(value: unknown): value is string {
  return typeof value === "string" && SCHEME_NAME_RE.test(value);
}

/** Caller return URL: https, or http only for loopback development. */
export function isSafeReturnUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/**
 * True when the raw scheme is an authorization-code `oauth2` scheme that
 * names a provider. Other OAuth schemes are documentation only, as before.
 */
function isConnectedAccountScheme(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw.type === "oauth2" &&
    raw[OAUTH_PROVIDER_EXTENSION] !== undefined &&
    isRecord(raw.flows) &&
    isRecord(raw.flows.authorizationCode)
  );
}

type CollectedSchemes = {
  schemes: ConnectedAccountScheme[];
  issues: OAuthSchemeIssue[];
  byName: ReadonlyMap<string, ConnectedAccountScheme>;
};

const NO_SCHEMES: CollectedSchemes = {
  schemes: [],
  issues: [],
  byName: new Map(),
};
// Keyed by the `securitySchemes` object: publish validation and every gateway
// call ask per operation, and parsed specs are cached and never mutated.
const collected = new WeakMap<object, CollectedSchemes>();

/**
 * Validate every provider-bound scheme. Returns usable schemes plus issues; a
 * scheme with any issue is left out of `schemes`. Results are shared; don't
 * mutate them.
 */
export function collectOAuthSchemes(
  spec: Pick<ParsedOpenApiSpec, "components">,
): CollectedSchemes {
  const raw = spec.components?.securitySchemes;
  if (!isRecord(raw)) return NO_SCHEMES;
  let result = collected.get(raw);
  if (result === undefined) {
    result = validateOAuthSchemes(raw);
    collected.set(raw, result);
  }
  return result;
}

function validateOAuthSchemes(
  securitySchemes: Record<string, unknown>,
): CollectedSchemes {
  const schemes: ConnectedAccountScheme[] = [];
  const issues: OAuthSchemeIssue[] = [];
  let count = 0;
  for (const [name, raw] of Object.entries(securitySchemes)) {
    if (!isConnectedAccountScheme(raw)) continue;
    count += 1;
    const path = `$.components.securitySchemes["${name}"]`;
    const before = issues.length;
    const scheme = raw as Record<string, unknown> & {
      flows: { authorizationCode: Record<string, unknown> };
    };
    const flow = scheme.flows.authorizationCode;
    if (!SCHEME_NAME_RE.test(name)) {
      issues.push({
        path,
        message:
          "OAuth scheme names must be 1-64 letters, digits, dots, underscores or hyphens",
      });
    }
    const provider = getOAuthProvider(String(scheme[OAUTH_PROVIDER_EXTENSION]));
    if (provider === null) {
      issues.push({
        path: `${path}.${OAUTH_PROVIDER_EXTENSION}`,
        message: "Unknown provider. Supported: youtube, tiktok, instagram",
      });
      continue;
    }
    // The spec documents the flow; Zevium always uses its own endpoints.
    if (flow.authorizationUrl !== provider.authorizationUrl) {
      issues.push({
        path: `${path}.flows.authorizationCode.authorizationUrl`,
        message: `authorizationUrl must be ${provider.authorizationUrl} for ${provider.id}`,
      });
    }
    if (flow.tokenUrl !== provider.tokenUrl) {
      issues.push({
        path: `${path}.flows.authorizationCode.tokenUrl`,
        message: `tokenUrl must be ${provider.tokenUrl} for ${provider.id}`,
      });
    }
    const scopes = isRecord(flow.scopes) ? Object.keys(flow.scopes) : null;
    if (scopes === null) {
      issues.push({
        path: `${path}.flows.authorizationCode.scopes`,
        message: "scopes must be an object (it may be empty)",
      });
    } else {
      const unknown = scopes.filter((s) => !provider.scopes.includes(s));
      if (unknown.length > 0) {
        issues.push({
          path: `${path}.flows.authorizationCode.scopes`,
          message: `Scopes not available for ${provider.id}: ${unknown.slice(0, 3).join(", ")}`,
        });
      }
    }
    if (issues.length === before) {
      schemes.push({ name, provider: provider.id, scopes: scopes ?? [] });
    }
  }
  if (count > MAX_OAUTH_SCHEMES) {
    issues.push({
      path: "$.components.securitySchemes",
      message: `At most ${MAX_OAUTH_SCHEMES} connected-account schemes`,
    });
  }
  return {
    schemes,
    issues,
    byName: new Map(schemes.map((scheme) => [scheme.name, scheme])),
  };
}

/**
 * Connected tokens only ever reach the provider's own API. The listing's
 * upstream (`servers[0].url`) must be one of each used provider's hosts.
 */
export function collectConnectionUpstreamIssues(
  spec: Pick<ParsedOpenApiSpec, "components"> & { servers?: unknown },
): OAuthSchemeIssue[] {
  const { schemes } = collectOAuthSchemes(spec);
  if (schemes.length === 0) return [];
  const first = Array.isArray(spec.servers) ? spec.servers[0] : undefined;
  let host: string | null = null;
  try {
    host =
      isRecord(first) && typeof first.url === "string"
        ? new URL(first.url).hostname
        : null;
  } catch {
    host = null;
  }
  return schemes
    .map((scheme) => getOAuthProvider(scheme.provider)!)
    .filter((provider) => host === null || !isProviderApiHost(provider, host))
    .map((provider) => ({
      path: "$.servers[0].url",
      message: `Connected ${provider.name} accounts can only call ${provider.apiHosts.join(" or ")}`,
    }));
}

function effectiveSecurity(
  spec: Pick<ParsedOpenApiSpec, "security">,
  operation: OpenApiOperation,
): Record<string, unknown>[] {
  const raw = Array.isArray(operation.security)
    ? operation.security
    : (spec.security ?? []);
  return raw.filter(isRecord);
}

function oauthEntries(
  alternative: Record<string, unknown>,
  schemes: ReadonlyMap<string, ConnectedAccountScheme>,
): { scheme: ConnectedAccountScheme; scopes: string[] }[] {
  return Object.entries(alternative).flatMap(([name, scopes]) => {
    const scheme = schemes.get(name);
    if (!scheme) return [];
    return [
      {
        scheme,
        scopes: Array.isArray(scopes)
          ? scopes.filter((s): s is string => typeof s === "string")
          : [],
      },
    ];
  });
}

/**
 * Connected account an operation needs, or `null` for none. OpenAPI security
 * is a list of alternatives; the connection is required only when every
 * alternative names a provider-bound scheme.
 */
export function operationConnection(
  spec: Pick<ParsedOpenApiSpec, "components" | "security">,
  operation: OpenApiOperation,
): ConnectionRequirement | null {
  const schemes = collectOAuthSchemes(spec).byName;
  if (schemes.size === 0) return null;
  const alternatives = effectiveSecurity(spec, operation);
  let found: { scheme: ConnectedAccountScheme; scopes: string[] } | undefined;
  let required = alternatives.length > 0;
  for (const alternative of alternatives) {
    const entries = oauthEntries(alternative, schemes);
    if (entries.length === 0) {
      required = false;
      continue;
    }
    found ??= entries[0];
  }
  return found
    ? {
        scheme: found.scheme.name,
        provider: found.scheme.provider,
        scopes: found.scopes,
        required,
      }
    : null;
}

/** Issues for operations that mix provider-bound schemes. */
export function collectOperationConnectionIssues(
  spec: Pick<ParsedOpenApiSpec, "components" | "security">,
  operation: OpenApiOperation,
  path: string,
): OAuthSchemeIssue[] {
  const schemes = collectOAuthSchemes(spec).byName;
  if (schemes.size === 0) return [];
  const used = new Set<string>();
  for (const alternative of effectiveSecurity(spec, operation)) {
    for (const entry of oauthEntries(alternative, schemes))
      used.add(entry.scheme.name);
  }
  return used.size > 1
    ? [
        {
          path: `${path}.security`,
          message: "An operation can use at most one connected-account scheme",
        },
      ]
    : [];
}

/** Scopes requested at connect time: every scope any operation needs. */
export function requestedScopes(
  spec: Pick<ParsedOpenApiSpec, "components" | "security" | "paths">,
  scheme: ConnectedAccountScheme,
): string[] {
  const declared = new Set(scheme.scopes);
  const scopes = new Set<string>();
  for (const item of Object.values(spec.paths)) {
    for (const [key, operation] of Object.entries(item ?? {})) {
      if (key === "parameters" || !isRecord(operation)) continue;
      const need = operationConnection(spec, operation as OpenApiOperation);
      if (need?.scheme !== scheme.name) continue;
      for (const scope of need.scopes)
        if (declared.has(scope)) scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

export function buildAuthorizationUrl(input: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  /** PKCE S256 challenge; `null` for providers without PKCE. */
  codeChallenge: string | null;
  scopes: string[];
}): string {
  const { provider } = input;
  const url = new URL(provider.authorizationUrl);
  for (const [key, value] of Object.entries(provider.authorizeParams)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set(provider.clientIdParam, input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (input.codeChallenge !== null) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(provider.scopeSeparator));
  }
  return url.toString();
}

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry in ms, `null` when the provider gives none. */
  expiresAt: number | null;
  scopes: string[] | null;
};

function parseBody(
  contentType: string,
  body: string,
): Record<string, unknown> | null {
  if (contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse a token endpoint response (RFC 6749 §5). Only bearer tokens are
 * accepted; providers that omit `token_type` are treated as bearer.
 * `grantRejected` means the grant itself is dead (reconnect needed).
 */
export function parseTokenResponse(
  status: number,
  contentType: string,
  body: string,
  now: number,
): { ok: true; tokens: OAuthTokenSet } | { ok: false; grantRejected: boolean } {
  const parsed = parseBody(contentType, body);
  // Instagram's code grant wraps the token in `data: [{...}]`.
  const value =
    parsed !== null &&
    Array.isArray(parsed.data) &&
    parsed.data.length === 1 &&
    isRecord(parsed.data[0])
      ? parsed.data[0]
      : parsed;
  const error =
    typeof value?.error === "string"
      ? value.error
      : // Graph-style errors: code 190 means the token itself is dead.
        isRecord(value?.error) && value.error.code === 190
        ? "invalid_grant"
        : null;
  if (status < 200 || status >= 300 || value === null || error !== null) {
    return {
      ok: false,
      grantRejected:
        error === "invalid_grant" ||
        error === "unauthorized_client" ||
        error === "invalid_client",
    };
  }
  const accessToken = value.access_token;
  const tokenType = value.token_type;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    /[\r\n]/.test(accessToken) ||
    (tokenType !== undefined &&
      (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"))
  ) {
    return { ok: false, grantRejected: false };
  }
  const refresh = value.refresh_token;
  const expiresIn = Number(value.expires_in);
  const scope = value.scope ?? value.permissions;
  return {
    ok: true,
    tokens: {
      accessToken,
      refreshToken:
        typeof refresh === "string" &&
        refresh.length > 0 &&
        refresh.length <= MAX_TOKEN_LENGTH
          ? refresh
          : null,
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0
          ? now + Math.min(expiresIn, 10 * 365 * 24 * 3600) * 1000
          : null,
      scopes:
        typeof scope === "string"
          ? scope.split(/[\s,]+/).filter((s) => s.length > 0)
          : null,
    },
  };
}
