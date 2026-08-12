import { describe, expect, it } from "vitest";

import {
  buildMcpConfigSnippet,
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
