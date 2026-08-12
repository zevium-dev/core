import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { HEAD_SHA, MERGE_SHA, TEST_PUBLIC_JWK } from "./test/fixtures";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.origin === "https://token.actions.githubusercontent.com") {
            return Response.json(
              { keys: [TEST_PUBLIC_JWK] },
              { headers: { "cache-control": "public, max-age=3600" } },
            );
          }
          if (
            url.origin === "https://api.github.com" &&
            url.pathname === "/repos/zevium-dev/core/pulls/123"
          ) {
            return Response.json({
              base: {
                ref: "develop",
                repo: { full_name: "zevium-dev/core", id: 1044451612 },
              },
              head: {
                ref: "broker-branch",
                repo: { full_name: "zevium-dev/core", id: 1044451612 },
                sha: HEAD_SHA,
              },
              merge_commit_sha: MERGE_SHA,
              merged: false,
              number: 123,
              state: "open",
            });
          }
          if (url.origin === "https://api.cloudflare.com") {
            if (url.pathname.endsWith("/settings")) {
              return new Response(null, {
                headers: { location: "https://evil.invalid/capture" },
                status: 302,
              });
            }
            const body = request.body ? await request.text() : "";
            return Response.json(
              {
                errors: [],
                messages: [],
                result: {
                  authorization: request.headers.get("authorization"),
                  bodyLength: body.length,
                  contentLength: request.headers.get("content-length"),
                  default_environment: {
                    script: { migration_tag: "v1" },
                  },
                  method: request.method,
                  pathname: url.pathname,
                },
                success: true,
              },
              {
                headers: {
                  "set-cookie": "cloudflare-secret=forbidden",
                  "www-authenticate": "Bearer upstream-secret",
                  "x-upstream-secret": "forbidden",
                },
              },
            );
          }
          return new Response("outbound request rejected", { status: 599 });
        },
      },
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
