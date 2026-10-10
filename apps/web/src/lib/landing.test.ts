import { describe, expect, it } from "vitest";

import {
  buildMcpConfigSnippet,
  buildClaudeCodeInstall,
  buildCodexConfigSnippet,
  buildCursorInstallUrl,
  discoveryEndpointUrl,
  mcpEndpointUrl,
  pickLandingTeasers,
  resolveGatewayOrigin,
  tryItBaseUrl,
} from "./landing";

describe("resolveGatewayOrigin", () => {
  it("strips trailing slashes from env", () => {
    expect(resolveGatewayOrigin("https://gw.example.com/gateway/")).toBe(
      "https://gw.example.com/gateway",
    );
  });

  it("falls back when env empty", () => {
    expect(resolveGatewayOrigin(undefined)).toBe("http://localhost:8787");
    expect(resolveGatewayOrigin("   ")).toBe("http://localhost:8787");
  });
});

describe("mcpEndpointUrl", () => {
  it("appends /mcp to origin", () => {
    expect(mcpEndpointUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/mcp",
    );
  });

  it("strips trailing /gateway before /mcp", () => {
    expect(mcpEndpointUrl("https://gw.example.com/gateway")).toBe(
      "https://gw.example.com/mcp",
    );
  });
});

describe("discoveryEndpointUrl", () => {
  it("points at /discovery", () => {
    expect(discoveryEndpointUrl("http://localhost:8787/gateway")).toBe(
      "http://localhost:8787/discovery",
    );
  });
});

describe("tryItBaseUrl", () => {
  it("normalizes the real gateway URL", () => {
    expect(tryItBaseUrl("http://localhost:8787/gateway", false)).toBe(
      "http://localhost:8787/gateway",
    );
    expect(tryItBaseUrl("http://localhost:8787", false)).toBe(
      "http://localhost:8787/gateway",
    );
  });

  it("swaps /gateway for /mock", () => {
    expect(tryItBaseUrl("http://localhost:8787/gateway", true)).toBe(
      "http://localhost:8787/mock",
    );
    expect(tryItBaseUrl("https://gw.example.com/gateway/", true)).toBe(
      "https://gw.example.com/mock",
    );
  });

  it("appends /mock to a bare origin", () => {
    expect(tryItBaseUrl("http://localhost:8787", true)).toBe(
      "http://localhost:8787/mock",
    );
  });
});

describe("buildMcpConfigSnippet", () => {
  it("embeds mcp url and api key placeholder", () => {
    const snip = buildMcpConfigSnippet("http://localhost:8787/mcp");
    expect(snip).toContain('"url": "http://localhost:8787/mcp"');
    expect(snip).toContain("YOUR_API_KEY");
    expect(snip).toContain("mcpServers");
  });
});

describe("pickLandingTeasers", () => {
  it("returns only real catalogue items", () => {
    const teasers = pickLandingTeasers([
      {
        name: "Real",
        slug: "real",
        publisherHandle: "acme",
        orgName: "Acme",
        description: null,
      },
    ]);
    expect(teasers).toHaveLength(1);
    expect(teasers[0]).toMatchObject({
      name: "Real",
      description: "No description provided.",
    });
  });

  it("does not manufacture listings when catalogue is empty", () => {
    expect(pickLandingTeasers([])).toEqual([]);
  });

  it("honors a non-negative display limit", () => {
    const item = {
      name: "Real",
      slug: "real",
      publisherHandle: "acme",
      orgName: "Acme",
      description: "Real API",
    };
    expect(pickLandingTeasers([item, item], 1)).toHaveLength(1);
    expect(pickLandingTeasers([item], -1)).toEqual([]);
  });
});

describe("agent install formats", () => {
  it("Cursor deeplink decodes to the same single-server config as the JSON fallback", () => {
    const mcpUrl = "https://edge.example.test/mcp?label=café&test=1";
    const link = new URL(buildCursorInstallUrl(mcpUrl));
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    expect(link.searchParams.get("name")).toBe("zevium");
    const decoded = JSON.parse(
      Buffer.from(link.searchParams.get("config")!, "base64").toString("utf8"),
    );
    expect(decoded).toEqual(
      JSON.parse(buildMcpConfigSnippet(mcpUrl)).mcpServers.zevium,
    );
    expect(decoded.headers.Authorization).toBe("Bearer ak_YOUR_API_KEY");
  });

  it("quotes the Claude Code endpoint as a literal shell argument", () => {
    expect(buildClaudeCodeInstall("https://edge.example.test/mcp")).toBe(
      "claude mcp add --transport http zevium 'https://edge.example.test/mcp' --header \"Authorization: Bearer ak_YOUR_API_KEY\"",
    );
    expect(
      buildClaudeCodeInstall("https://edge.example.test/mcp?label='test'"),
    ).toContain("'\\''test'\\''");
  });

  it("Codex uses the HTTP server and header table syntax", () => {
    expect(buildCodexConfigSnippet("https://edge.example.test/mcp")).toBe(
      '[mcp_servers.zevium]\nurl = "https://edge.example.test/mcp"\nhttp_headers = { "Authorization" = "Bearer ak_YOUR_API_KEY" }',
    );
  });
});
