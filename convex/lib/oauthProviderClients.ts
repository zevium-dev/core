import type { OAuthProvider } from "@zevium/shared";

/**
 * Zevium's own OAuth client for a provider, from deployment environment
 * (`OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET`, ...). Read at use
 * time so rotating a secret needs no data migration. `null` = not configured.
 */
export function providerClient(
  provider: OAuthProvider,
): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[`OAUTH_${provider.client}_CLIENT_ID`]?.trim();
  const clientSecret =
    process.env[`OAUTH_${provider.client}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Publisher handles allowed to list APIs that use Zevium's provider clients
 * (`OAUTH_PROVIDER_PUBLISHERS`, comma-separated). Unset allows none: every
 * connected token is issued under Zevium's provider apps, so only listings
 * Zevium reviews may request them.
 */
export function isProviderPublisher(handle: string | undefined): boolean {
  if (!handle) return false;
  return (process.env.OAUTH_PROVIDER_PUBLISHERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(handle.toLowerCase());
}
