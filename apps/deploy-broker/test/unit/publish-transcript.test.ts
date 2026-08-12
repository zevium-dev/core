/// <reference types="node" />

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishProfile } from "../../scripts/publish.ts";
import type { DeploymentProfile } from "../../src/manifest.ts";

interface TranscriptEntry {
  method: string;
  path: string;
}

const SESSION = "a".repeat(64);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
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

async function expectedTranscript(component: "gateway" | "web") {
  return JSON.parse(
    await readFile(
      new URL(
        `../../transcripts/exact-api-v1-${component}.json`,
        import.meta.url,
      ),
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
  ] as const)(
    "emits real closed %s multipart for %s lifecycle",
    async (component, lifecycle) => {
      const root = await mkdtemp(
        join(tmpdir(), `zevium-${component}-publish-`),
      );
      temporaryRoots.push(root);
      const moduleRoot = join(root, "modules");
      const assetRoot = join(root, "assets");
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
              jwt: "initial.asset.session",
            });
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
          if (url.pathname.endsWith("/deployments")) {
            const body = (await request.json()) as {
              versions: Array<{ percentage: number; version_id: string }>;
            };
            expect(body.versions).toEqual([
              { percentage: 100, version_id: VERSION_ID },
            ]);
            return cloudflareEnvelope({
              id: "22222222-2222-4222-8222-222222222222",
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

      await publishProfile(profile);

      expect(transcript).toEqual(await expectedTranscript(component));
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
            ]
          : ["secret_text:CLERK_SECRET_KEY"],
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
    },
  );
});
