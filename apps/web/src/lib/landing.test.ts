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
  const fallbacks = [
    {
      name: "Weather",
      slug: "weather",
      publisherHandle: "demo",
      orgName: "Demo",
      description: "Forecasts.",
    },
    {
      name: "FX",
      slug: "fx",
      publisherHandle: "demo",
      orgName: "Demo",
      description: "Rates.",
    },
  ] as const;

  it("prefers live items and marks live", () => {
    const teasers = pickLandingTeasers(
      [
        {
          name: "Real",
          slug: "real",
          publisherHandle: "acme",
          orgName: "Acme",
          description: null,
        },
      ],
      fallbacks,
    );
    expect(teasers).toHaveLength(1);
    expect(teasers[0]).toMatchObject({
      name: "Real",
      live: true,
      description: "Published OpenAPI API.",
    });
  });

  it("uses fallbacks as not-live when catalogue empty", () => {
    const teasers = pickLandingTeasers([], fallbacks);
    expect(teasers).toHaveLength(2);
    expect(teasers.every((t) => t.live === false)).toBe(true);
    expect(teasers[0]?.slug).toBe("weather");
  });
});
