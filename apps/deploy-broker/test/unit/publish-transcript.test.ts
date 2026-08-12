/// <reference types="node" />

import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishProfile } from "../../scripts/publish.ts";
import {
  buildFromEnvironment,
  readRecoveryReceipt,
} from "../../scripts/register.ts";
import { manifestDigest, type DeploymentProfile } from "../../src/manifest.ts";
import { DEPLOYMENT_RECEIPT_SCHEMA } from "../../src/receipt.ts";

interface TranscriptEntry {
  method: string;
  path: string;
}

const SESSION = "a".repeat(64);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PRIOR_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PRIOR_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const SINGLE_ASSET_JWT = `header.${Buffer.from(
  JSON.stringify({ wrangler_single_asset_uploads: true }),
).toString("base64url")}.signature`;
const temporaryRoots: string[] = [];

function cloudflareEnvelope(
  result: Record<string, unknown>,
  init?: ResponseInit,
): Response {
  return Response.json(
    { errors: [], messages: [], result, success: true },
    init,
  );
}

function stubDeploymentEnvironment(
  profile: DeploymentProfile,
  moduleRoot: string,
  assetRoot?: string,
): void {
  const values: Record<string, string> = {
    CLERK_SECRET_KEY: "transcript-clerk-secret",
    CLOUDFLARE_API_BASE_URL: `https://deploy-broker.zevium.dev/sessions/${SESSION}/client/v4`,
    CLOUDFLARE_API_TOKEN: "github-oidc-transcript-token",
    CONVEX_SITE_URL: "https://preview-123.convex.site",
    DEPLOY_HEAD_SHA: "a".repeat(40),
    DEPLOY_MAIN_MODULE: "index.js",
    DEPLOY_MODULE_ROOT: moduleRoot,
    GATEWAY_INTERNAL_SECRET: "transcript-gateway-secret",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/123/merge",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "9001",
    GITHUB_SHA: "b".repeat(40),
    PR_NUMBER: "123",
    VITE_CONVEX_URL: "https://preview-123.convex.cloud",
  };
  if (assetRoot) values.DEPLOY_ASSET_ROOT = assetRoot;
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  expect(profile).toMatch(/^preview-(?:gateway|web)$/);
}

async function expectedTranscript(
  component: "gateway" | "web",
  lifecycle: "existing" | "initial" | "none" | "single",
) {
  const suffix = lifecycle === "single" ? "web-single" : component;
  return JSON.parse(
    await readFile(
      new URL(`../../transcripts/exact-api-v1-${suffix}.json`, import.meta.url),
      "utf8",
    ),
  ) as TranscriptEntry[];
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("repo-owned exact Cloudflare API publisher", () => {
  it.each([
    ["gateway", "existing"],
    ["gateway", "initial"],
    ["web", "none"],
    ["web", "single"],
  ] as const)(
    "emits real closed %s multipart for %s lifecycle",
    async (component, lifecycle) => {
      const root = await mkdtemp(
        join(tmpdir(), `zevium-${component}-publish-`),
      );
      temporaryRoots.push(root);
      const moduleRoot = join(root, "modules");
      const assetRoot = join(root, "assets");
      const receiptPath = join(root, "deployment-receipt.json");
      await mkdir(moduleRoot);
      await writeFile(
        join(moduleRoot, "index.js"),
        "export default { fetch() { return new Response('exact') } }\n",
      );
      if (component === "web") {
        await mkdir(assetRoot);
        await Promise.all([
          writeFile(join(assetRoot, "index.html"), "<h1>exact web</h1>\n"),
          writeFile(join(assetRoot, "styles.css"), "body { color: black; }\n"),
        ]);
      }
      const profile = `preview-${component}` as DeploymentProfile;
      stubDeploymentEnvironment(
        profile,
        moduleRoot,
        component === "web" ? assetRoot : undefined,
      );
      vi.stubEnv(
        "CLOUDFLARE_DEPLOY_MANIFEST_DIGEST",
        await manifestDigest(await buildFromEnvironment(profile)),
      );

      const transcript: TranscriptEntry[] = [];
      let versionMetadata: Record<string, unknown> | undefined;
      let uploadedModule = "";
      const uploadedAssets: Record<string, string> = {};
      let requestedAssetHashes: string[] = [];
      let assetUploadCount = 0;
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          transcript.push({
            method: request.method,
            path: `${url.pathname.replace(/^\/sessions\/[0-9a-f]{64}/, "")}${url.search}`,
          });

          if (
            url.pathname.endsWith(`/workers/services/zevium-gateway-pr-123`)
          ) {
            if (lifecycle === "initial") {
              return cloudflareEnvelope({}, { status: 404 });
            }
            return cloudflareEnvelope({
              default_environment: { script: { migration_tag: "v1" } },
            });
          }
          if (
            request.method === "GET" &&
            url.pathname.endsWith("/deployments")
          ) {
            return cloudflareEnvelope({
              deployments:
                lifecycle === "existing"
                  ? [
                      {
                        id: PRIOR_DEPLOYMENT_ID,
                        strategy: "percentage",
                        versions: [
                          { percentage: 100, version_id: PRIOR_VERSION_ID },
                        ],
                      },
                    ]
                  : [],
            });
          }
          if (url.pathname.endsWith("/assets-upload-session")) {
            const body = (await request.json()) as {
              manifest: Record<string, { hash: string; size: number }>;
            };
            requestedAssetHashes = [
              body.manifest["/index.html"]?.hash ?? "",
              body.manifest["/styles.css"]?.hash ?? "",
            ];
            expect(requestedAssetHashes).toEqual([
              expect.stringMatching(/^[0-9a-f]{32}$/),
              expect.stringMatching(/^[0-9a-f]{32}$/),
            ]);
            return cloudflareEnvelope({
              buckets: requestedAssetHashes.map((hash) => [hash]),
              jwt:
                lifecycle === "single"
                  ? SINGLE_ASSET_JWT
                  : "initial.asset.session",
            });
          }
          if (url.pathname.includes("/workers/assets/upload/")) {
            expect(lifecycle).toBe("single");
            expect(request.headers.get("authorization")).toBe(
              `Bearer ${SINGLE_ASSET_JWT}`,
            );
            const hash = url.pathname.split("/").at(-1)!;
            const assetIndex = requestedAssetHashes.indexOf(hash);
            expect(assetIndex).toBeGreaterThanOrEqual(0);
            const bytes = Buffer.from(await request.arrayBuffer());
            expect(request.headers.get("content-length")).toBe(
              String(bytes.byteLength),
            );
            expect(request.headers.get("content-type")).toBe(
              assetIndex === 0
                ? "text/html; charset=utf-8"
                : "text/css; charset=utf-8",
            );
            uploadedAssets[hash] = bytes.toString("utf8");
            assetUploadCount += 1;
            return cloudflareEnvelope(
              assetUploadCount === requestedAssetHashes.length
                ? { jwt: "complete.asset.session" }
                : {},
            );
          }
          if (url.pathname.endsWith("/workers/assets/upload")) {
            expect(request.headers.get("authorization")).toBe(
              "Bearer initial.asset.session",
            );
            const form = await request.formData();
            const present = requestedAssetHashes.filter(
              (hash) => form.get(hash) !== null,
            );
            expect(present).toHaveLength(1);
            const hash = present[0]!;
            const value = form.get(hash);
            expect(value).toBeInstanceOf(Blob);
            expect((value as Blob).type).toBe(
              hash === requestedAssetHashes[0]
                ? "text/html; charset=utf-8"
                : "text/css; charset=utf-8",
            );
            uploadedAssets[hash] = Buffer.from(
              await (value as Blob).text(),
              "base64",
            ).toString("utf8");
            assetUploadCount += 1;
            return cloudflareEnvelope(
              assetUploadCount === requestedAssetHashes.length
                ? { jwt: "complete.asset.session" }
                : {},
            );
          }
          if (url.pathname.endsWith("/versions")) {
            const form = await request.formData();
            versionMetadata = JSON.parse(
              String(form.get("metadata")),
            ) as Record<string, unknown>;
            const module = form.get("index.js");
            expect(module).toBeInstanceOf(Blob);
            uploadedModule = await (module as Blob).text();
            return cloudflareEnvelope({ id: VERSION_ID });
          }
          if (
            request.method === "POST" &&
            url.pathname.endsWith("/deployments")
          ) {
            const body = (await request.json()) as {
              versions: Array<{ percentage: number; version_id: string }>;
            };
            expect(body.versions).toEqual([
              { percentage: 100, version_id: VERSION_ID },
            ]);
            return cloudflareEnvelope({
              id: DEPLOYMENT_ID,
            });
          }
          if (url.pathname.endsWith("/subdomain")) {
            expect(await request.json()).toEqual({
              enabled: true,
              previews_enabled: true,
            });
            return cloudflareEnvelope({ enabled: true });
          }
          return new Response("unexpected API request", { status: 599 });
        },
      );

      await publishProfile(profile, { receiptPath });

      expect(transcript).toEqual(
        await expectedTranscript(component, lifecycle),
      );
      expect(uploadedModule).toBe(
        "export default { fetch() { return new Response('exact') } }\n",
      );
      expect(versionMetadata).toBeDefined();
      expect(versionMetadata).not.toHaveProperty("keep_bindings");
      expect(versionMetadata).not.toHaveProperty("keep_assets");
      const bindings = versionMetadata?.bindings as Array<{
        name: string;
        text?: string;
        type: string;
      }>;
      expect(
        bindings.map(({ name, type }) => `${type}:${name}`).sort(),
      ).toEqual(
        component === "gateway"
          ? [
              "durable_object_namespace:WALLET",
              "plain_text:CONVEX_SITE_URL",
              "plain_text:CONVEX_URL",
              "secret_text:CLERK_SECRET_KEY",
              "secret_text:GATEWAY_INTERNAL_SECRET",
              "version_metadata:CF_VERSION_METADATA",
            ]
          : [
              "secret_text:CLERK_SECRET_KEY",
              "version_metadata:CF_VERSION_METADATA",
            ],
      );
      expect(
        bindings.find(({ name }) => name === "CLERK_SECRET_KEY")?.text,
      ).toBe("transcript-clerk-secret");
      if (component === "gateway") {
        expect(
          bindings.find(({ name }) => name === "GATEWAY_INTERNAL_SECRET")?.text,
        ).toBe("transcript-gateway-secret");
        expect(versionMetadata?.migrations).toEqual(
          lifecycle === "initial"
            ? {
                new_tag: "v1",
                steps: [{ new_sqlite_classes: ["WalletDO"] }],
              }
            : undefined,
        );
      } else {
        expect(uploadedAssets).toEqual({
          [requestedAssetHashes[0]!]: "<h1>exact web</h1>\n",
          [requestedAssetHashes[1]!]: "body { color: black; }\n",
        });
        expect(versionMetadata?.assets).toEqual({
          config: {},
          jwt: "complete.asset.session",
        });
      }
      const receiptState = await stat(receiptPath);
      expect(receiptState.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
        artifactDigests: {
          modules: [
            {
              name: "index.js",
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
          ],
          staticAssets:
            component === "web"
              ? [
                  {
                    path: "/index.html",
                    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                  },
                  {
                    path: "/styles.css",
                    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                  },
                ]
              : [],
        },
        deploymentId: DEPLOYMENT_ID,
        gitSha: "a".repeat(40),
        manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        phase: "activated",
        priorDeploymentId:
          lifecycle === "existing" ? PRIOR_DEPLOYMENT_ID : null,
        priorVersionId: lifecycle === "existing" ? PRIOR_VERSION_ID : null,
        profile,
        schema: "zevium.cloudflare-deploy-receipt/v1",
        target: `zevium-${component}-pr-123`,
        versionId: VERSION_ID,
      });
    },
  );

  it("persists recovery intent then redeploys only receipt-bound prior staging version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zevium-recovery-publish-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "failed.json");
    const outputPath = join(root, "recovered.json");
    const priorDeploymentId = "33333333-3333-4333-8333-333333333333";
    const priorVersionId = "44444444-4444-4444-8444-444444444444";
    await writeFile(
      sourcePath,
      `${JSON.stringify(
        {
          artifactDigests: {
            modules: [{ name: "index.js", sha256: "1".repeat(64) }],
            staticAssets: [],
          },
          createdAt: "2026-08-12T09:00:00.000Z",
          deploymentId: "55555555-5555-4555-8555-555555555555",
          gitSha: "a".repeat(40),
          manifestDigest: "2".repeat(64),
          phase: "activated",
          priorDeploymentId,
          priorVersionId,
          profile: "staging-gateway",
          recovery: null,
          schema: DEPLOYMENT_RECEIPT_SCHEMA,
          target: "zevium-gateway-staging",
          versionId: "66666666-6666-4666-8666-666666666666",
        },
        null,
        2,
      )}\n`,
    );
    await chmod(sourcePath, 0o600);
    const values: Record<string, string> = {
      CLERK_SECRET_KEY: "transcript-clerk-secret",
      CLOUDFLARE_API_BASE_URL: `https://deploy-broker.zevium.dev/sessions/${SESSION}/client/v4`,
      CLOUDFLARE_API_TOKEN: "github-oidc-transcript-token",
      CONVEX_SITE_URL: "https://zevium-stage.convex.site",
      DEPLOY_HEAD_SHA: "a".repeat(40),
      GATEWAY_INTERNAL_SECRET: "transcript-gateway-secret",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/develop",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "9003",
      GITHUB_SHA: "a".repeat(40),
      SOURCE_RUN_ID: "8999",
      VITE_CONVEX_URL: "https://zevium-stage.convex.cloud",
    };
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
    const recoveryReceipt = await readRecoveryReceipt(sourcePath);
    vi.stubEnv(
      "CLOUDFLARE_DEPLOY_MANIFEST_DIGEST",
      await manifestDigest(
        await buildFromEnvironment("staging-gateway", { recoveryReceipt }),
      ),
    );

    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push({
          body: await request.clone().json(),
          method: request.method,
          path: url.pathname.replace(/^\/sessions\/[0-9a-f]{64}/, ""),
        });
        return cloudflareEnvelope({
          id: DEPLOYMENT_ID,
          recovery_mode: "redeployed_prior",
          recovery_release_sha: "d".repeat(40),
        });
      },
    );

    await publishProfile("staging-gateway", {
      receiptPath: outputPath,
      recoveryReceiptPath: sourcePath,
    });

    expect(requests).toEqual([
      {
        body: {
          annotations: {
            "workers/message": `Zevium compatible prior recovery ${priorVersionId}`,
          },
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: priorVersionId }],
        },
        method: "POST",
        path: "/client/v4/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-staging/deployments",
      },
    ]);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      phase: "recovered",
      gitSha: "d".repeat(40),
      priorDeploymentId,
      priorVersionId,
      recovery: {
        failedDeploymentId: "55555555-5555-4555-8555-555555555555",
        failedGitSha: "a".repeat(40),
        failedVersionId: "66666666-6666-4666-8666-666666666666",
        mode: "redeployed_prior",
        sourceReceiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      versionId: priorVersionId,
    });
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects publisher artifact drift after broker registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "zevium-drift-publish-"));
    temporaryRoots.push(root);
    const moduleRoot = join(root, "modules");
    await mkdir(moduleRoot);
    await writeFile(
      join(moduleRoot, "index.js"),
      "export default { fetch() { return new Response('drift') } }\n",
    );
    stubDeploymentEnvironment("preview-gateway", moduleRoot);
    vi.stubEnv("CLOUDFLARE_DEPLOY_MANIFEST_DIGEST", "f".repeat(64));
    const fetch = vi.fn(() => {
      throw new Error("provider must not be called");
    });
    vi.stubGlobal("fetch", fetch);

    await expect(publishProfile("preview-gateway")).rejects.toThrow(
      "broker session is not bound to rebuilt deployment manifest",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
