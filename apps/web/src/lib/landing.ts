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

/** Public placeholder only; Clerk-issued keys currently use the ak_ prefix. */
export const API_KEY_PLACEHOLDER = "ak_YOUR_API_KEY";

function mcpServerConfig(mcpUrl: string) {
  return {
    url: mcpUrl,
    headers: { Authorization: `Bearer ${API_KEY_PLACEHOLDER}` },
  };
}

/** MCP client config JSON string for agent paste. */
export function buildMcpConfigSnippet(mcpUrl: string): string {
  return JSON.stringify(
    { mcpServers: { zevium: mcpServerConfig(mcpUrl) } },
    null,
    2,
  );
}

export function buildClaudeCodeInstall(mcpUrl: string): string {
  // Single quotes preserve literal URL characters in POSIX shells.
  const quotedUrl = "'" + mcpUrl.replaceAll("'", "'\\''") + "'";
  return `claude mcp add --transport http zevium ${quotedUrl} --header "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`;
}

export function buildCodexConfigSnippet(mcpUrl: string): string {
  return `[mcp_servers.zevium]
url = ${JSON.stringify(mcpUrl)}
http_headers = { "Authorization" = "Bearer ${API_KEY_PLACEHOLDER}" }`;
}

/** https://cursor.com/docs/mcp/install-links — config is one server, not mcpServers. */
export function buildCursorInstallUrl(mcpUrl: string): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify(mcpServerConfig(mcpUrl)),
  );
  const base64 = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=zevium&config=${encodeURIComponent(base64)}`;
}

export type LandingTeaser = {
  name: string;
  slug: string;
  publisherHandle: string;
  orgName: string;
  description: string;
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
  limit = 3,
): LandingTeaser[] {
  return liveItems.slice(0, Math.max(0, limit)).map((item) => ({
    name: item.name,
    slug: item.slug,
    publisherHandle: item.publisherHandle,
    orgName: item.orgName,
    description: item.description ?? "No description provided.",
  }));
}
