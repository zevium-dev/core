import { readFileSync } from "node:fs";
import { CREDITS_PER_DOLLAR } from "@zevium/shared";
import { describe, expect, it } from "vitest";

import { buildLlmsText, llmsResponse } from "./llms";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

// Read gateway source as a route contract; the web runtime never imports the Worker.
const gatewayIndex = source("../../../gateway/src/index.ts");
const gatewayRoutes = new Set(
  Array.from(
    gatewayIndex.matchAll(
      /parts\[0\] === "(mcp|discovery)" && parts.length === 1/g,
    ),
    (match) => `/${match[1]}`,
  ),
);
for (const [file, parser] of [
  ["pipeline", "parseGatewayPath"],
  ["mock", "parseMockPath"],
]) {
  const routeSource = source(`../../../gateway/src/${file}.ts`);
  if (!gatewayIndex.includes(`${parser}(url.pathname)`)) continue;
  const prefix = routeSource.match(
    /if \(parts\[0\] !== "([^"]+)"\) return null;/,
  )?.[1];
  if (prefix) {
    gatewayRoutes.add(`/${prefix}/{publisherHandle}/{projectSlug}/{path}`);
  }
}
const routeTree = source("../routeTree.gen.ts");
const webRoutes = new Set(
  Array.from(
    routeTree.matchAll(/fullPath: ['"]([^'"]+)['"]/g),
    (match) => match[1],
  ),
);

describe("llms.txt", () => {
  it.each(["https://edge.example.test", "https://edge.example.test/gateway/"])(
    "every published URL resolves to a web or known gateway route (%s)",
    (gateway) => {
      const text = buildLlmsText("https://web.example.test", gateway);
      const urls = Array.from(
        text.matchAll(/https?:\/\/[^\s)]+/g),
        (match) => new URL(match[0]),
      );
      expect(urls.length).toBeGreaterThanOrEqual(10);
      for (const url of urls) {
        const path = decodeURIComponent(url.pathname);
        if (url.origin === "https://web.example.test") {
          expect(
            Array.from(webRoutes).some(
              (route) =>
                route.replace(/\/$/, "") === path ||
                (route.endsWith("/$") &&
                  (path === route.slice(0, -2) ||
                    path.startsWith(route.slice(0, -1)))),
            ),
            `Missing web route: ${path}`,
          ).toBe(true);
        } else {
          expect(url.origin).toBe("https://edge.example.test");
          expect(
            gatewayRoutes.has(path),
            `Missing gateway route: ${path}`,
          ).toBe(true);
        }
      }
      expect(webRoutes.has("/llms.txt")).toBe(true);
      expect(text).toContain(
        `$1 = ${CREDITS_PER_DOLLAR.toLocaleString("en-US")} credits`,
      );
      expect(text).not.toContain("/gateway/gateway");
    },
  );

  it("serves anonymous plain text with request-origin links and configured gateway", async () => {
    const response = llmsResponse(
      new Request("https://preview.example.test/llms.txt"),
      "https://edge.example.test/gateway/",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    const text = await response.text();
    expect(text).toContain("https://preview.example.test/app/settings/keys");
    expect(text).toContain("https://edge.example.test/mcp");
    expect(text).toContain("Bearer ak_YOUR_API_KEY");
    expect(text).toContain(
      "402: missing_api_key, invalid_api_key, or insufficient_credits",
    );
    expect(text).toContain(
      "403: key_disabled, key_untracked, key_cap_exceeded",
    );
    expect(text).toContain("404: project_not_found");
    expect(text).toContain("not an x402 payment challenge");
  });
});
