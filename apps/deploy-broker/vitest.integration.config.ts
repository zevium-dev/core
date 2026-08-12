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
            if (
              !url.pathname.endsWith("/workers/assets/upload") &&
              request.headers.get("authorization") !==
                "Bearer cf-test-broker-token"
            ) {
              return new Response("wrong broker credential", { status: 401 });
            }
            if (url.pathname.endsWith("/assets-upload-session")) {
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  buckets: [["b".repeat(32)], ["c".repeat(32)]],
                  jwt: "asset.initial.jwt",
                },
                success: true,
              });
            }
            if (url.pathname.endsWith("/workers/assets/upload")) {
              await request.arrayBuffer();
              return Response.json({
                errors: [],
                messages: [],
                result: { jwt: "asset-completion-token.segment.signature" },
                success: true,
              });
            }
            if (request.headers.get("user-agent") === "redirect-test") {
              return new Response(null, {
                headers: { location: "https://evil.invalid/capture" },
                status: 302,
              });
            }
            if (
              request.method === "GET" &&
              /\/workers\/scripts\/zevium-(?:gateway|web)-pr-123\/versions\/[0-9a-f-]+$/.test(
                url.pathname,
              )
            ) {
              const versionId = url.pathname.split("/").at(-1);
              const isWeb = url.pathname.includes("/zevium-web-pr-123/");
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: versionId,
                  resources: isWeb
                    ? {
                        bindings: [
                          { name: "CLERK_SECRET_KEY", type: "secret_text" },
                        ],
                        script: { etag: "a".repeat(64) },
                        script_runtime: {
                          compatibility_date: "2026-07-18",
                          compatibility_flags: ["nodejs_compat"],
                        },
                      }
                    : {
                        bindings: [
                          {
                            name: "CONVEX_SITE_URL",
                            text: "https://preview-123.convex.site",
                            type: "plain_text",
                          },
                          {
                            name: "CONVEX_URL",
                            text: "https://preview-123.convex.cloud",
                            type: "plain_text",
                          },
                          {
                            class_name: "WalletDO",
                            name: "WALLET",
                            type: "durable_object_namespace",
                          },
                          { name: "CLERK_SECRET_KEY", type: "secret_text" },
                          {
                            name: "GATEWAY_INTERNAL_SECRET",
                            type: "secret_text",
                          },
                        ],
                        script: { etag: "a".repeat(64) },
                        script_runtime: {
                          compatibility_date: "2025-04-01",
                          compatibility_flags: ["global_fetch_strictly_public"],
                          migration_tag: "v1",
                        },
                      },
                },
                success: true,
              });
            }
            if (
              request.method === "GET" &&
              /\/workers\/scripts\/zevium-gateway-pr-123\/deployments\/[0-9a-f-]+$/.test(
                url.pathname,
              )
            ) {
              const deploymentId = url.pathname.split("/").at(-1);
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: deploymentId,
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: "11111111-1111-4111-8111-111111111111",
                    },
                  ],
                },
                success: true,
              });
            }
            if (
              request.method === "GET" &&
              url.pathname.endsWith(
                "/workers/scripts/zevium-gateway-pr-123/deployments",
              )
            ) {
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  deployments: [
                    {
                      id: "22222222-2222-4222-8222-222222222222",
                      strategy: "percentage",
                      versions: [
                        {
                          percentage: 100,
                          version_id: "11111111-1111-4111-8111-111111111111",
                        },
                      ],
                    },
                  ],
                },
                success: true,
              });
            }
            if (
              request.method === "POST" &&
              url.pathname.endsWith(
                "/workers/scripts/zevium-gateway-pr-123/deployments",
              )
            ) {
              await request.text();
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: "22222222-2222-4222-8222-222222222222",
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: "11111111-1111-4111-8111-111111111111",
                    },
                  ],
                },
                success: true,
              });
            }
            const body = request.body ? await request.text() : "";
            const declaredLength = request.headers.get("content-length");
            if (
              request.method === "POST" &&
              url.pathname.endsWith("/versions") &&
              declaredLength !== null &&
              Number(declaredLength) !==
                new TextEncoder().encode(body).byteLength
            ) {
              return new Response("canonical content length mismatch", {
                status: 422,
              });
            }
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
                  id: "11111111-1111-4111-8111-111111111111",
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
