/** Resolve gateway origin from env; strip trailing slash. No hardcoded prod. */
export function resolveGatewayOrigin(
  envValue: string | undefined,
  fallback = "http://localhost:8787",
): string {
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim().replace(/\/+$/, "");
  }
  return fallback.replace(/\/+$/, "");
}

/** MCP Streamable HTTP URL on the gateway origin. */
export function mcpEndpointUrl(gatewayOrigin: string): string {
  const origin = gatewayOrigin.replace(/\/+$/, "");
  // VITE_GATEWAY_URL may be origin or .../gateway — normalize to origin then /mcp
  const base = origin.replace(/\/gateway$/i, "");
  return `${base}/mcp`;
}

/** Machine-readable discovery index URL. */
export function discoveryEndpointUrl(gatewayOrigin: string): string {
  const origin = gatewayOrigin.replace(/\/+$/, "");
  const base = origin.replace(/\/gateway$/i, "");
  return `${base}/discovery`;
}

/** MCP client config JSON string for agent paste. */
export function buildMcpConfigSnippet(mcpUrl: string): string {
  return `{
  "mcpServers": {
    "zevium": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}`;
}

export type LandingTeaser = {
  name: string;
  slug: string;
  orgSlug: string;
  orgName: string;
  description: string;
  live: boolean;
};

export type CatalogueListItem = {
  name: string;
  slug: string;
  orgSlug: string;
  orgName: string;
  description?: string | null;
};

/**
 * Map live catalogue items → teasers, else static fallbacks (not live).
 * Fallback cards must not deep-link to missing demo routes.
 */
export function pickLandingTeasers(
  liveItems: CatalogueListItem[],
  fallbacks: ReadonlyArray<Omit<LandingTeaser, "live">>,
  limit = 3,
): LandingTeaser[] {
  if (liveItems.length > 0) {
    return liveItems.slice(0, limit).map((item) => ({
      name: item.name,
      slug: item.slug,
      orgSlug: item.orgSlug,
      orgName: item.orgName,
      description: item.description ?? "Published OpenAPI API.",
      live: true,
    }));
  }
  return fallbacks.slice(0, limit).map((t) => ({ ...t, live: false }));
}
