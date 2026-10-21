import { describe, expect, it } from "vitest";

import { discoveryEndpointUrl, mcpEndpointUrl, tryItBaseUrl } from "./llms.js";

describe("gateway URL helpers", () => {
  it("trim trailing slashes and a trailing /gateway segment as before", () => {
    expect(mcpEndpointUrl("https://gw.test")).toBe("https://gw.test/mcp");
    expect(mcpEndpointUrl("https://gw.test///")).toBe("https://gw.test/mcp");
    expect(mcpEndpointUrl("https://gw.test/gateway/")).toBe(
      "https://gw.test/mcp",
    );
    expect(discoveryEndpointUrl("https://gw.test/GATEWAY")).toBe(
      "https://gw.test/discovery",
    );
    expect(tryItBaseUrl("https://gw.test/gateway//", true)).toBe(
      "https://gw.test/mock",
    );
    expect(tryItBaseUrl("https://gw.test", false)).toBe(
      "https://gw.test/gateway",
    );
    expect(mcpEndpointUrl("///")).toBe("/mcp");
  });

  it("stay linear on long slash runs that do not end the string", () => {
    const crafted = "https://gw.test" + "/".repeat(200_000) + "x";
    const start = performance.now();
    expect(mcpEndpointUrl(crafted)).toBe(crafted + "/mcp");
    expect(performance.now() - start).toBeLessThan(250);
  });
});
