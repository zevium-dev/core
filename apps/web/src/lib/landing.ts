import { API_KEY_PLACEHOLDER } from "@zevium/shared";

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
