"use node";

import { v } from "convex/values";
import {
  getOAuthProvider,
  parseTokenResponse,
  type OAuthProvider,
  type OAuthTokenSet,
} from "@zevium/shared";

import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  connectionSecretBinding,
  decryptSecret,
  encryptSecret,
} from "./lib/credentialCrypto";
import { providerClient } from "./lib/oauthProviderClients";
import { requestPinnedHttpsForBody } from "./lib/webhookTransport";
import { envelope } from "./schema/common";

export type AuthorizationOutcome = {
  status: "active" | "denied" | "failed" | "expired" | "invalid";
  connectionId: string | null;
  returnUrl: string | null;
};

export type RefreshOutcome =
  | { status: "ok"; accessToken: string; accessExpiresAt: number | null }
  | { status: "reauthorize" | "busy" | "unavailable" };

type ProviderClient = { clientId: string; clientSecret: string };

type TokenResult =
  { ok: true; tokens: OAuthTokenSet } | { ok: false; grantRejected: boolean };

const HEADERS = {
  accept: "application/json",
  "user-agent": "Zevium-Connections/1",
};

async function send(
  method: "GET" | "POST",
  url: URL,
  headers: Record<string, string>,
  body?: string,
): Promise<TokenResult> {
  try {
    const response = await requestPinnedHttpsForBody({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const parsed = parseTokenResponse(
      response.status,
      response.contentType,
      response.body,
      Date.now(),
    );
    return parsed.ok
      ? parsed
      : { ok: false, grantRejected: parsed.failure.grantRejected };
  } catch {
    return { ok: false, grantRejected: false };
  }
}

/** Form POST to the provider's token endpoint with Zevium's client auth. */
async function postTokenForm(
  provider: OAuthProvider,
  client: ProviderClient,
  url: string,
  grant: Record<string, string>,
): Promise<TokenResult> {
  const form = new URLSearchParams(grant);
  const headers: Record<string, string> = {
    ...HEADERS,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (provider.tokenAuthMethod === "client_secret_basic") {
    // RFC 6749 §2.3.1: form-encode each part before joining.
    const user = encodeURIComponent(client.clientId);
    const pass = encodeURIComponent(client.clientSecret);
    headers.authorization = `Basic ${btoa(`${user}:${pass}`)}`;
  } else {
    form.set(provider.clientIdParam, client.clientId);
    form.set("client_secret", client.clientSecret);
  }
  return await send("POST", new URL(url), headers, form.toString());
}

/** Instagram-style GET grant (long-lived swap or refresh). */
async function getTokenGrant(
  url: string,
  params: Record<string, string>,
): Promise<TokenResult> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return await send("GET", target, HEADERS);
}

async function exchangeCode(
  provider: OAuthProvider,
  client: ProviderClient,
  code: string,
  redirectUri: string,
  verifier: string | null,
): Promise<TokenResult> {
  const result = await postTokenForm(provider, client, provider.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(verifier === null ? {} : { code_verifier: verifier }),
  });
  if (!result.ok || provider.longLived === undefined) return result;
  // The code grant yields a 1-hour token; swap it for the 60-day one.
  const long = await getTokenGrant(provider.longLived.exchangeUrl, {
    grant_type: "ig_exchange_token",
    client_secret: client.clientSecret,
    access_token: result.tokens.accessToken,
  });
  return long.ok
    ? {
        ok: true,
        tokens: {
          ...long.tokens,
          scopes: long.tokens.scopes ?? result.tokens.scopes,
        },
      }
    : long;
}

async function sealTokens(connectionId: string, tokens: OAuthTokenSet) {
  return {
    accessToken: await encryptSecret(
      tokens.accessToken,
      connectionSecretBinding(connectionId, "access"),
    ),
    refreshToken:
      tokens.refreshToken === null
        ? undefined
        : await encryptSecret(
            tokens.refreshToken,
            connectionSecretBinding(connectionId, "refresh"),
          ),
    accessExpiresAt: tokens.expiresAt ?? undefined,
    grantedScopes: tokens.scopes ?? undefined,
  };
}

async function failAuthorization(
  ctx: ActionCtx,
  connectionId: string,
  error: string,
): Promise<void> {
  await ctx.runMutation(internal.connections.fail, {
    connectionId,
    from: "exchanging",
    error,
  });
}

/** Provider redirect: claim the state, exchange the code, store tokens. */
export const completeAuthorization = internalAction({
  args: {
    stateHash: v.string(),
    code: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AuthorizationOutcome> => {
    const claim = await ctx.runMutation(internal.connections.claimByState, {
      stateHash: args.stateHash,
    });
    if (claim === null) {
      return { status: "invalid", connectionId: null, returnUrl: null };
    }
    const { connectionId, returnUrl } = claim;
    if (claim.status === "expired") {
      return { status: "expired", connectionId, returnUrl };
    }
    if (args.error !== undefined || args.code === undefined) {
      const denied = args.error === "access_denied";
      await failAuthorization(
        ctx,
        connectionId,
        denied
          ? "The account owner declined the connection."
          : "The provider did not complete the authorization.",
      );
      return { status: denied ? "denied" : "failed", connectionId, returnUrl };
    }
    const provider = getOAuthProvider(claim.provider);
    const client = provider && providerClient(provider);
    if (!provider || !client) {
      await failAuthorization(
        ctx,
        connectionId,
        "Account connections for this provider are unavailable right now.",
      );
      return { status: "failed", connectionId, returnUrl };
    }
    const verifier =
      claim.codeVerifier === null
        ? null
        : await decryptSecret(
            claim.codeVerifier,
            connectionSecretBinding(connectionId, "verifier"),
          );
    const result = await exchangeCode(
      provider,
      client,
      args.code,
      claim.redirectUri,
      verifier,
    );
    if (!result.ok) {
      await failAuthorization(
        ctx,
        connectionId,
        "The provider rejected the authorization code. Start a new connection.",
      );
      return { status: "failed", connectionId, returnUrl };
    }
    const activated = await ctx.runMutation(internal.connections.activate, {
      connectionId,
      ...(await sealTokens(connectionId, result.tokens)),
    });
    return {
      status: activated ? "active" : "failed",
      connectionId,
      returnUrl,
    };
  },
});

/** Refresh one token revision under a lease; at most one caller refreshes. */
export const refresh = internalAction({
  args: { connectionId: v.string(), tokenRevision: v.number() },
  handler: async (ctx, args): Promise<RefreshOutcome> => {
    const lease = await ctx.runMutation(
      internal.connections.beginRefresh,
      args,
    );
    if (lease.status === "gone") return { status: "reauthorize" };
    if (lease.status === "busy") return { status: "busy" };
    const reauthorize = async (error: string): Promise<RefreshOutcome> => {
      await ctx.runMutation(internal.connections.fail, {
        connectionId: args.connectionId,
        from: "active",
        error,
      });
      return { status: "reauthorize" };
    };
    const provider = getOAuthProvider(lease.provider);
    if (provider === null) {
      return await reauthorize("This provider is no longer supported.");
    }
    // Missing client config is an outage, not a dead grant.
    const client = providerClient(provider);
    if (client === null) return { status: "unavailable" };
    let result: TokenResult;
    if (provider.longLived !== undefined) {
      if (lease.accessToken === null) {
        return await reauthorize("Access expired. Reconnect the account.");
      }
      result = await getTokenGrant(provider.longLived.refreshUrl, {
        grant_type: "ig_refresh_token",
        access_token: await decryptSecret(
          lease.accessToken,
          connectionSecretBinding(args.connectionId, "access"),
        ),
      });
    } else {
      if (lease.refreshToken === null) {
        return await reauthorize("Access expired. Reconnect the account.");
      }
      result = await postTokenForm(provider, client, provider.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: await decryptSecret(
          lease.refreshToken,
          connectionSecretBinding(args.connectionId, "refresh"),
        ),
      });
    }
    if (!result.ok) {
      // Transient failures keep the grant; the lease expires on its own.
      return result.grantRejected
        ? await reauthorize(
            "The provider revoked or expired this connection. Reconnect the account.",
          )
        : { status: "unavailable" };
    }
    const stored = await ctx.runMutation(internal.connections.completeRefresh, {
      ...args,
      ...(await sealTokens(args.connectionId, result.tokens)),
    });
    return stored
      ? {
          status: "ok",
          accessToken: result.tokens.accessToken,
          accessExpiresAt: result.tokens.expiresAt,
        }
      : { status: "busy" };
  },
});

/** Best-effort provider revocation after a disconnect; failures are ignored. */
export const revokeAtProvider = internalAction({
  args: {
    connectionId: v.string(),
    provider: v.string(),
    field: v.union(v.literal("access"), v.literal("refresh")),
    token: envelope,
  },
  handler: async (_ctx, args): Promise<boolean> => {
    const provider = getOAuthProvider(args.provider);
    const revocation = provider?.revoke;
    if (!provider || !revocation) return false;
    const form = new URLSearchParams({
      token: await decryptSecret(
        args.token,
        connectionSecretBinding(args.connectionId, args.field),
      ),
    });
    if (revocation.withClient) {
      const client = providerClient(provider);
      if (client === null) return false;
      form.set(provider.clientIdParam, client.clientId);
      form.set("client_secret", client.clientSecret);
    }
    try {
      const response = await requestPinnedHttpsForBody({
        method: "POST",
        url: new URL(revocation.url),
        headers: {
          ...HEADERS,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  },
});
