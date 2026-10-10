/** Clerk is the authorization server; this Worker is only a resource server. */
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { BoundedCache } from "./cache";
import {
  sha256Hex,
  type VerifiedKey,
  type VerifyOutcome,
} from "./key-verifier";

export const MCP_SCOPES = ["user:org:read", "zevium:mcp:execute"];
export type McpOAuthConfig = { issuer: string; resource: string };
export type McpOAuthOutcome = VerifyOutcome | { status: "insufficient_scope" };
export interface McpOAuthVerifier {
  verify(token: string): Promise<McpOAuthOutcome>;
}

export function oauthConfig(
  issuer?: string,
  resource?: string,
): McpOAuthConfig | null {
  if (!issuer || !resource) return null;
  const iss = new URL(issuer);
  const res = new URL(resource);
  if (
    iss.protocol !== "https:" ||
    res.protocol !== "https:" ||
    iss.username ||
    iss.password ||
    iss.search ||
    iss.hash ||
    iss.pathname !== "/" ||
    res.username ||
    res.password ||
    res.search ||
    res.hash ||
    res.pathname !== "/mcp"
  )
    throw new Error("Invalid MCP OAuth configuration");
  return { issuer: iss.origin, resource: res.href };
}

export function protectedResourceMetadata(config: McpOAuthConfig): Response {
  return Response.json(
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: MCP_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Zevium metered API marketplace",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export function oauthChallenge(
  config: McpOAuthConfig,
  error?: "invalid_token" | "insufficient_scope",
): Response {
  const metadata = `${new URL(config.resource).origin}/.well-known/oauth-protected-resource/mcp`;
  return Response.json(
    {
      error: error ?? "unauthorized",
      message: "Connect with OAuth or provide a valid Zevium API key",
    },
    {
      status: error === "insufficient_scope" ? 403 : 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPES.join(" ")}"${error ? `, error="${error}"` : ""}`,
      },
    },
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Signature/issuer/audience/expiry checked locally on EVERY request. JWKS is
 * cached for 5m, with a 30s refresh cooldown against random-kid fetch storms.
 * A separate 60s cache bounds opaque-token revocation and org/key mapping staleness.
 * JWT tokens can only be blocked by key controls until expiry; Clerk cannot revoke them.
 * Failed refreshes fail closed; no stale authorization survives an outage.
 */
export class ClerkMcpOAuthVerifier implements McpOAuthVerifier {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #cache: BoundedCache<{
    outcome: McpOAuthOutcome;
    expiresAt: number;
  }>;
  readonly #inflight = new Map<string, Promise<McpOAuthOutcome>>();
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(
    readonly options: McpOAuthConfig & {
      secretKey: string;
      siteUrl: string;
      internalSecret: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#cache = new BoundedCache(512, 60_000, this.#now);
    this.#jwks = createRemoteJWKSet(
      new URL(`${options.issuer}/.well-known/jwks.json`),
      {
        [customFetch]: this.#fetch,
        cacheMaxAge: 300_000,
        cooldownDuration: 30_000,
        timeoutDuration: 3000,
      },
    );
  }

  async verify(token: string): Promise<McpOAuthOutcome> {
    if (token.length > 16_384) return { status: "invalid" };
    if (token.startsWith("oat_")) {
      return this.#cached(await sha256Hex(token), () =>
        this.#resolveOpaque(token),
      );
    }
    let claims;
    try {
      const result = await jwtVerify(token, this.#jwks, {
        algorithms: ["RS256"],
        issuer: this.options.issuer,
        audience: this.options.resource,
        requiredClaims: ["exp", "iat", "sub", "jti", "client_id", "org_id"],
        currentDate: new Date(this.#now()),
      });
      if (
        !["at+jwt", "application/at+jwt"].includes(
          result.protectedHeader.typ?.toLowerCase() ?? "",
        )
      )
        return { status: "invalid" };
      claims = result.payload;
    } catch (error) {
      const invalid =
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JWKSNoMatchingKey;
      return { status: invalid ? "invalid" : "unavailable" };
    }
    const { sub, org_id: orgId, jti, client_id: clientId, iat } = claims;
    const scopes = Array.isArray(claims.scp)
      ? claims.scp
      : typeof claims.scope === "string"
        ? claims.scope.split(" ")
        : [];
    if (
      typeof sub !== "string" ||
      !sub.startsWith("user_") ||
      sub.length > 256 ||
      typeof orgId !== "string" ||
      !orgId.startsWith("org_") ||
      orgId.length > 256 ||
      typeof jti !== "string" ||
      !jti ||
      typeof clientId !== "string" ||
      !clientId ||
      typeof iat !== "number" ||
      iat > this.#now() / 1000
    )
      return { status: "invalid" };
    if (!MCP_SCOPES.every((scope) => scopes.includes(scope)))
      return { status: "insufficient_scope" };
    return this.#cached(await sha256Hex(token), async () => ({
      outcome: await this.#resolveIdentity(sub, orgId),
      expiresAt: claims.exp! * 1000,
    }));
  }

  async #cached(
    digest: string,
    load: () => Promise<{ outcome: McpOAuthOutcome; expiresAt: number }>,
  ): Promise<McpOAuthOutcome> {
    const cached = this.#cache.get(digest);
    if (cached)
      return cached.expiresAt <= this.#now()
        ? { status: "invalid" }
        : cached.outcome;
    const pending = this.#inflight.get(digest);
    if (pending) return pending;
    const refresh = load()
      .then((entry) => {
        if (entry.expiresAt <= this.#now())
          return { status: "invalid" as const };
        if (entry.outcome.status !== "unavailable")
          this.#cache.set(digest, entry);
        return entry.outcome;
      })
      .finally(() => this.#inflight.delete(digest));
    this.#inflight.set(digest, refresh);
    return refresh;
  }

  /** Clerk JWTs are stateless and irrevocable. Opaque grants supply revocation. */
  async #resolveOpaque(
    token: string,
  ): Promise<{ outcome: McpOAuthOutcome; expiresAt: number }> {
    const result = (
      outcome: McpOAuthOutcome,
      expiresAt = this.#now() + 60_000,
    ) => ({ outcome, expiresAt });
    try {
      const response = await this.#fetch(
        "https://api.clerk.com/v1/oauth_applications/access_tokens/verify",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.secretKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_token: token }),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        },
      );
      if (response.status === 400 || response.status === 404)
        return result({ status: "invalid" });
      if (!response.ok) return result({ status: "unavailable" });
      const state: unknown = await response.json();
      if (
        !record(state) ||
        typeof state.revoked !== "boolean" ||
        typeof state.expired !== "boolean"
      )
        return result({ status: "unavailable" });
      if (
        state.revoked ||
        state.expired ||
        typeof state.expiration !== "number" ||
        !Number.isFinite(state.expiration) ||
        state.expiration * 1000 <= this.#now() ||
        typeof state.subject !== "string" ||
        !state.subject.startsWith("user_") ||
        state.subject.length > 256 ||
        !Array.isArray(state.aud) ||
        !state.aud.includes(this.options.resource)
      )
        return result({ status: "invalid" });
      const grantedScopes = state.scopes;
      if (
        !Array.isArray(grantedScopes) ||
        !MCP_SCOPES.every((scope) => grantedScopes.includes(scope))
      )
        return result({ status: "insufficient_scope" });
      // Backend token verification omits org_id. Clerk's userinfo endpoint
      // returns the org selected during consent; never infer it from user input.
      const infoResponse = await this.#fetch(
        `${this.options.issuer}/oauth/userinfo`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        },
      );
      if (infoResponse.status === 401) return result({ status: "invalid" });
      if (!infoResponse.ok) return result({ status: "unavailable" });
      const info: unknown = await infoResponse.json();
      if (
        !record(info) ||
        info.sub !== state.subject ||
        typeof info.org_id !== "string" ||
        !info.org_id.startsWith("org_") ||
        info.org_id.length > 256
      )
        return result({ status: "invalid" });
      return result(
        await this.#resolveIdentity(state.subject, info.org_id),
        state.expiration * 1000,
      );
    } catch {
      return result({ status: "unavailable" });
    }
  }

  async #resolveIdentity(
    userId: string,
    orgId: string,
  ): Promise<VerifyOutcome> {
    try {
      const res = await this.#fetch(`${this.options.siteUrl}/mcp-identity`, {
        method: "POST",
        headers: {
          "x-internal-secret": this.options.internalSecret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId, orgId }),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!res.ok) return { status: "unavailable" };
      const value: unknown = await res.json();
      if (value === null) return { status: "invalid" };
      if (
        !record(value) ||
        value.orgId !== orgId ||
        typeof value.keyId !== "string" ||
        !value.keyId
      )
        return { status: "unavailable" };
      const key: VerifiedKey = {
        orgId,
        keyId: value.keyId,
        scopes: ["gateway:execute"],
      };
      return { status: "ok", key };
    } catch {
      return { status: "unavailable" };
    }
  }
}
