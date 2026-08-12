import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { HEAD_SHA, MERGE_SHA, TEST_PUBLIC_JWK } from "./test/fixtures";

const STANDARD_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DELAYED_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const RESUMED_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const STANDARD_DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const RESUMED_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const FAILED_STAGING_DEPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
const FAILED_STAGING_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PRIOR_STAGING_DEPLOYMENT_ID = "88888888-8888-4888-8888-888888888888";
const PRIOR_STAGING_VERSION_ID = "99999999-9999-4999-8999-999999999999";
const RECOVERY_STAGING_DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SINGLE_ASSET_JWT =
  "asset.eyJ3cmFuZ2xlcl9zaW5nbGVfYXNzZXRfdXBsb2FkcyI6dHJ1ZX0.signature";
const readAttempts = new Map<string, number>();
let resumedVersionPosts = 0;
let resumedDeploymentPosts = 0;
let latestDeploymentId = STANDARD_DEPLOYMENT_ID;
let stagingRecovered = false;

function nextReadAttempt(id: string): number {
  const count = (readAttempts.get(id) ?? 0) + 1;
  readAttempts.set(id, count);
  return count;
}

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
          if (
            url.origin === "https://api.github.com" &&
            url.pathname === "/repos/zevium-dev/core/actions/runs/8999"
          ) {
            return Response.json({
              conclusion: "success",
              event: "push",
              head_branch: "develop",
              head_repository: { id: 1044451612 },
              head_sha: HEAD_SHA,
              id: 8999,
              name: "Continuous Integration",
              path: ".github/workflows/ci.yml",
              repository: { id: 1044451612 },
              status: "completed",
            });
          }
          if (url.origin === "https://api.cloudflare.com") {
            const assetUpload =
              /\/workers\/assets\/upload(?:\/[0-9a-f]{32})?$/.test(
                url.pathname,
              );
            if (
              !assetUpload &&
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
                  jwt:
                    request.headers.get("user-agent") === "single-assets-test"
                      ? SINGLE_ASSET_JWT
                      : "asset.initial.jwt",
                },
                success: true,
              });
            }
            if (assetUpload) {
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
              url.pathname.endsWith("/workers/services/zevium-gateway-staging")
            ) {
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  default_environment: { script: { migration_tag: "v3" } },
                },
                success: true,
              });
            }
            if (
              request.method === "GET" &&
              /\/workers\/scripts\/zevium-(?:gateway|web)(?:-pr-123|-staging)\/versions\/[0-9a-f-]+$/.test(
                url.pathname,
              )
            ) {
              const versionId = url.pathname.split("/").at(-1);
              const attempt = nextReadAttempt(versionId ?? "");
              if (versionId === DELAYED_VERSION_ID && attempt <= 2) {
                return new Response("version pending", { status: 404 });
              }
              if (versionId === RESUMED_VERSION_ID && attempt <= 5) {
                return new Response("version transient", { status: 503 });
              }
              const isWeb = url.pathname.includes("/zevium-web-pr-123/");
              const isStaging = url.pathname.includes("-staging/");
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: versionId,
                  resources: isWeb
                    ? {
                        bindings: [
                          { name: "CLERK_SECRET_KEY", type: "secret_text" },
                          {
                            name: "CF_VERSION_METADATA",
                            type: "version_metadata",
                          },
                        ],
                        script: { etag: "a".repeat(64) },
                        script_runtime: {
                          compatibility_date: "2026-07-18",
                          compatibility_flags: ["nodejs_compat"],
                        },
                      }
                    : isStaging
                      ? {
                          bindings: [
                            {
                              name: "CONVEX_SITE_URL",
                              text: "https://zevium-stage.convex.site",
                              type: "plain_text",
                            },
                            {
                              name: "CONVEX_URL",
                              text: "https://zevium-stage.convex.cloud",
                              type: "plain_text",
                            },
                            {
                              name: "ZEVIUM_RELEASE",
                              text: "d".repeat(40),
                              type: "plain_text",
                            },
                            {
                              class_name: "WalletDO",
                              name: "WALLET",
                              type: "durable_object_namespace",
                            },
                            {
                              class_name: "RegistryDO",
                              name: "REGISTRY",
                              type: "durable_object_namespace",
                            },
                            {
                              class_name: "X402PaymentDO",
                              name: "X402_PAYMENTS",
                              type: "durable_object_namespace",
                            },
                            { name: "CLERK_SECRET_KEY", type: "secret_text" },
                            {
                              name: "GATEWAY_INTERNAL_SECRET",
                              type: "secret_text",
                            },
                            {
                              name: "CF_VERSION_METADATA",
                              type: "version_metadata",
                            },
                          ],
                          script: { etag: "d".repeat(64) },
                          script_runtime: {
                            compatibility_date: "2025-04-01",
                            compatibility_flags: [
                              "global_fetch_strictly_public",
                            ],
                            migration_tag: "v3",
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
                            {
                              name: "CF_VERSION_METADATA",
                              type: "version_metadata",
                            },
                          ],
                          script: { etag: "a".repeat(64) },
                          script_runtime: {
                            compatibility_date: "2025-04-01",
                            compatibility_flags: [
                              "global_fetch_strictly_public",
                            ],
                            migration_tag: "v1",
                          },
                        },
                },
                success: true,
              });
            }
            if (
              request.method === "GET" &&
              /\/workers\/scripts\/zevium-gateway-staging\/deployments\/[0-9a-f-]+$/.test(
                url.pathname,
              )
            ) {
              const deploymentId = url.pathname.split("/").at(-1)!;
              const versionId =
                deploymentId === FAILED_STAGING_DEPLOYMENT_ID
                  ? FAILED_STAGING_VERSION_ID
                  : PRIOR_STAGING_VERSION_ID;
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: deploymentId,
                  strategy: "percentage",
                  versions: [{ percentage: 100, version_id: versionId }],
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
              const attempt = nextReadAttempt(deploymentId ?? "");
              if (deploymentId === RESUMED_DEPLOYMENT_ID && attempt <= 5) {
                return new Response("deployment transient", { status: 503 });
              }
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: deploymentId,
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: STANDARD_VERSION_ID,
                    },
                  ],
                },
                success: true,
              });
            }
            if (
              request.method === "GET" &&
              url.pathname.endsWith(
                "/workers/scripts/zevium-gateway-staging/deployments",
              )
            ) {
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  deployments: [
                    ...(stagingRecovered
                      ? [
                          {
                            id: RECOVERY_STAGING_DEPLOYMENT_ID,
                            strategy: "percentage",
                            versions: [
                              {
                                percentage: 100,
                                version_id: PRIOR_STAGING_VERSION_ID,
                              },
                            ],
                          },
                        ]
                      : [
                          {
                            id: FAILED_STAGING_DEPLOYMENT_ID,
                            strategy: "percentage",
                            versions: [
                              {
                                percentage: 100,
                                version_id: FAILED_STAGING_VERSION_ID,
                              },
                            ],
                          },
                        ]),
                    {
                      id: PRIOR_STAGING_DEPLOYMENT_ID,
                      strategy: "percentage",
                      versions: [
                        {
                          percentage: 100,
                          version_id: PRIOR_STAGING_VERSION_ID,
                        },
                      ],
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
                      id: latestDeploymentId,
                      strategy: "percentage",
                      versions: [
                        {
                          percentage: 100,
                          version_id: STANDARD_VERSION_ID,
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
                "/workers/scripts/zevium-gateway-staging/deployments",
              )
            ) {
              const body = (await request.json()) as {
                versions?: Array<{ version_id?: string }>;
              };
              if (body.versions?.[0]?.version_id !== PRIOR_STAGING_VERSION_ID) {
                return new Response("wrong recovery version", { status: 422 });
              }
              stagingRecovered = true;
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: RECOVERY_STAGING_DEPLOYMENT_ID,
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: PRIOR_STAGING_VERSION_ID,
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
              const resume =
                request.headers.get("user-agent") ===
                "resume-deployment-readback";
              if (resume) {
                resumedDeploymentPosts += 1;
                if (resumedDeploymentPosts > 1) {
                  return new Response("duplicate deployment POST", {
                    status: 409,
                  });
                }
              }
              latestDeploymentId = resume
                ? RESUMED_DEPLOYMENT_ID
                : STANDARD_DEPLOYMENT_ID;
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: latestDeploymentId,
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: STANDARD_VERSION_ID,
                    },
                  ],
                },
                success: true,
              });
            }
            if (
              request.method === "POST" &&
              url.pathname.endsWith("/versions") &&
              (request.headers.get("user-agent") ===
                "delayed-version-readback" ||
                request.headers.get("user-agent") === "resume-version-readback")
            ) {
              await request.text();
              const resume =
                request.headers.get("user-agent") === "resume-version-readback";
              if (resume) {
                resumedVersionPosts += 1;
                if (resumedVersionPosts > 1) {
                  return new Response("duplicate version POST", {
                    status: 409,
                  });
                }
              }
              return Response.json({
                errors: [],
                messages: [],
                result: {
                  id: resume ? RESUMED_VERSION_ID : DELAYED_VERSION_ID,
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
