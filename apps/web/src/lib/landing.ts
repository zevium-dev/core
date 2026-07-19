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
  const base = origin.replace(/\/gateway$/i, "");
  return `${base}/mcp`;
}

/** Machine-readable discovery index URL. */
export function discoveryEndpointUrl(gatewayOrigin: string): string {
  const origin = gatewayOrigin.replace(/\/+$/, "");
  const base = origin.replace(/\/gateway$/i, "");
  return `${base}/discovery`;
}

/** Public mock and paid gateway base URL. */
export function tryItBaseUrl(gatewayBaseUrl: string, mock: boolean): string {
  const trimmed = gatewayBaseUrl.replace(/\/+$/, "");
  const origin = trimmed.replace(/\/gateway$/i, "");
  return `${origin}/${mock ? "mock" : "gateway"}`;
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
  publisherHandle: string;
  orgName: string;
  description: string;
  live: boolean;
};

export type CatalogueListItem = {
  name: string;
  slug: string;
  publisherHandle: string;
  orgName: string;
  description?: string | null;
};

export function pickLandingTeasers(
  liveItems: CatalogueListItem[],
  fallbacks: ReadonlyArray<Omit<LandingTeaser, "live">>,
  limit = 3,
): LandingTeaser[] {
  if (liveItems.length > 0) {
    return liveItems.slice(0, limit).map((item) => ({
      name: item.name,
      slug: item.slug,
      publisherHandle: item.publisherHandle,
      orgName: item.orgName,
      description: item.description ?? "Published OpenAPI API.",
      live: true,
    }));
  }
  return fallbacks.slice(0, limit).map((item) => ({ ...item, live: false }));
}
