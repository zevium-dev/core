/**
 * OAuth providers Zevium is a registered client of.
 *
 * Zevium owns one OAuth app per provider. Endpoints, scopes and per-provider
 * differences live here, in reviewed code; only the client ID and secret come
 * from deployment environment (`OAUTH_<CLIENT>_CLIENT_ID` / `_SECRET`).
 * Publisher specs reference a provider by id and can never change where
 * Zevium's client secret or a user's token is sent.
 */

export type OAuthProviderId = "youtube" | "tiktok" | "instagram";

/**
 * - `standard`: RFC 6749 code and refresh-token grants.
 * - `instagram`: the code grant returns a 1-hour token that is swapped for a
 *   60-day one; refresh sends that token itself (no refresh token).
 */
export type OAuthTokenStyle = "standard" | "instagram";

export type OAuthProvider = {
  id: OAuthProviderId;
  /** Display name used in errors and consent copy. */
  name: string;
  /** Environment prefix: `OAUTH_${client}_CLIENT_ID` / `_CLIENT_SECRET`. */
  client: "GOOGLE" | "TIKTOK" | "INSTAGRAM";
  authorizationUrl: string;
  tokenUrl: string;
  /** Scopes a spec may request; anything else fails validation. */
  scopes: readonly string[];
  scopeSeparator: " " | ",";
  /** Name of the client id parameter (TikTok uses `client_key`). */
  clientIdParam: "client_id" | "client_key";
  /** Extra authorize parameters, e.g. Google's offline access. */
  authorizeParams: Readonly<Record<string, string>>;
  /** PKCE S256 on the authorization request. */
  pkce: boolean;
  tokenAuthMethod: "client_secret_post" | "client_secret_basic";
  tokenStyle: OAuthTokenStyle;
  /** `instagram` style: long-lived swap and refresh endpoints. */
  longLived?: { exchangeUrl: string; refreshUrl: string };
  /**
   * Best-effort revocation on disconnect: which token to send, and whether to
   * add client credentials (TikTok requires them).
   */
  revoke?: { url: string; token: "access" | "refresh"; withClient: boolean };
  /**
   * Long-lived tokens that die unused are renewed by a cron this long before
   * expiry. Short-lived tokens refresh on the call path instead.
   */
  renewBeforeMs?: number;
  /** The only upstream hosts that ever receive a connected token. */
  apiHosts: readonly string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";

export const OAUTH_PROVIDERS: Readonly<Record<OAuthProviderId, OAuthProvider>> =
  {
    youtube: {
      id: "youtube",
      name: "YouTube",
      client: "GOOGLE",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        `${GOOGLE_SCOPE}youtube.readonly`,
        `${GOOGLE_SCOPE}youtube.upload`,
        `${GOOGLE_SCOPE}youtube`,
        `${GOOGLE_SCOPE}youtube.force-ssl`,
      ],
      scopeSeparator: " ",
      clientIdParam: "client_id",
      // Without offline + consent Google omits the refresh token on reconnect.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      pkce: true,
      tokenAuthMethod: "client_secret_post",
      tokenStyle: "standard",
      // Revoking the refresh token ends the whole grant.
      revoke: {
        url: "https://oauth2.googleapis.com/revoke",
        token: "refresh",
        withClient: false,
      },
      apiHosts: ["www.googleapis.com", "youtube.googleapis.com"],
    },
    tiktok: {
      id: "tiktok",
      name: "TikTok",
      client: "TIKTOK",
      authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
      scopes: [
        "user.info.basic",
        "user.info.profile",
        "video.list",
        "video.upload",
        "video.publish",
      ],
      scopeSeparator: ",",
      clientIdParam: "client_key",
      authorizeParams: {},
      // TikTok's web flow takes no code challenge (desktop-only, hex-encoded).
      pkce: false,
      tokenAuthMethod: "client_secret_post",
      tokenStyle: "standard",
      revoke: {
        url: "https://open.tiktokapis.com/v2/oauth/revoke/",
        token: "access",
        withClient: true,
      },
      apiHosts: ["open.tiktokapis.com"],
    },
    instagram: {
      id: "instagram",
      name: "Instagram",
      client: "INSTAGRAM",
      authorizationUrl: "https://www.instagram.com/oauth/authorize",
      tokenUrl: "https://api.instagram.com/oauth/access_token",
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ],
      scopeSeparator: ",",
      clientIdParam: "client_id",
      authorizeParams: {},
      pkce: false,
      tokenAuthMethod: "client_secret_post",
      tokenStyle: "instagram",
      longLived: {
        exchangeUrl: "https://graph.instagram.com/access_token",
        refreshUrl: "https://graph.instagram.com/refresh_access_token",
      },
      // 60-day tokens expire if unused; renew a week ahead.
      renewBeforeMs: 7 * DAY_MS,
      apiHosts: ["graph.instagram.com"],
    },
  };

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === "string" && Object.hasOwn(OAUTH_PROVIDERS, value);
}

export function getOAuthProvider(id: string): OAuthProvider | null {
  return isOAuthProviderId(id) ? OAUTH_PROVIDERS[id] : null;
}

/** True when `host` may receive this provider's connected tokens. */
export function isProviderApiHost(
  provider: OAuthProvider,
  host: string,
): boolean {
  return provider.apiHosts.includes(host.toLowerCase());
}
