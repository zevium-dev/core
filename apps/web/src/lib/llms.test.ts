import { readFileSync } from "node:fs";
import { buildLlmsText, CREDITS_PER_DOLLAR } from "@zevium/shared";
import { describe, expect, it } from "vitest";

import { llmsResponse } from "./llms";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const routeTree = source("../routeTree.gen.ts");
const staticWebPaths = new Set(["/cli/zevium.mjs"]);
const webRoutes = new Set(
  Array.from(
    routeTree.matchAll(/fullPath: ['"]([^'"]+)['"]/g),
    (match) => match[1],
  ),
);

describe("llms.txt", () => {
  it.each(["https://edge.example.test", "https://edge.example.test/gateway/"])(
    "every web URL resolves to a web route; gateway URLs use the gateway origin (%s)",
    (gateway) => {
      const text = buildLlmsText({ web: "https://web.example.test", gateway });
      const urls = Array.from(
        text.matchAll(/https?:\/\/[^\s)'"]+/g),
        (match) => new URL(match[0]),
      );
      expect(urls.length).toBeGreaterThanOrEqual(10);
      for (const url of urls) {
        const path = decodeURIComponent(url.pathname);
        if (url.origin === "https://web.example.test") {
          expect(
            staticWebPaths.has(path) ||
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
          // apps/gateway/test/llms.test.ts exercises each gateway URL.
          expect(url.origin).toBe("https://edge.example.test");
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
    expect(text).toContain(
      "claude mcp add --transport http zevium 'https://edge.example.test/mcp'",
    );
    expect(text).toContain('url = "https://edge.example.test/mcp"');
    expect(text).toContain(
      "curl -fsSLo zevium https://preview.example.test/cli/zevium.mjs && chmod +x zevium",
    );
    expect(text).toContain("Generator major 2 is supported");
    expect(text).toContain("call_api_read({");
    expect(text).toContain("call_api_write({");
    expect(text).toContain("operation.call.tool");
    expect(text).not.toMatch(/\bcall_api\b/);
    expect(text).toContain(
      "https://edge.example.test/docs/{publisherHandle}/{projectSlug}",
    );
    expect(text).toContain("Bearer ak_YOUR_API_KEY");
    expect(text).toContain(
      "402: missing_api_key, invalid_api_key, or insufficient_credits",
    );
    expect(text).toContain("402: key_cap_exceeded");
    expect(text).toContain(
      "403: key_disabled, key_untracked, or consumer_not_entitled",
    );
    expect(text).toContain("429: key_rate_limited");
    expect(text).toContain("Retry-After");
    expect(text).toContain("404: project_not_found");
    expect(text).toContain("not an x402 payment challenge");
  });
});
