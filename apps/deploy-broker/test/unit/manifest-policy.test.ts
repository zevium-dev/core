import { describe, expect, it } from "vitest";
import {
  authorizeApiRoute,
  validateAssetInitBody,
  validateDeploymentBody,
  validateSecretBody,
  validateWorkerMetadata,
} from "../../src/api-policy";
import {
  buildManifest,
  canonicalJson,
  parseManifest,
} from "../../src/manifest";
import {
  HEAD_SHA,
  MERGE_SHA,
  PREVIEW_SECRET_DIGESTS,
  PRODUCTION_SHA,
} from "../fixtures";

function previewGateway() {
  return buildManifest({
    convexSiteUrl: "https://preview-123.convex.site",
    convexUrl: "https://preview-123.convex.cloud",
    eventName: "pull_request",
    headSha: HEAD_SHA,
    oidcSha: MERGE_SHA,
    prNumber: 123,
    profile: "preview-gateway",
    ref: "refs/pull/123/merge",
    runAttempt: 1,
    runId: "9001",
    secretDigests: PREVIEW_SECRET_DIGESTS,
  });
}

function productionGateway() {
  return buildManifest({
    eventName: "workflow_run",
    headSha: HEAD_SHA,
    oidcSha: PRODUCTION_SHA,
    profile: "production-gateway",
    ref: "refs/heads/develop",
    runAttempt: 1,
    runId: "9002",
    sourceRunId: "8999",
  });
}

describe("signed deployment manifest", () => {
  it("rebuilds canonical policy instead of trusting serialized targets", () => {
    const manifest = previewGateway();
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest);
    const forged = structuredClone(manifest);
    forged.targets[0]?.operations.push("script:delete");
    expect(() => parseManifest(forged)).toThrow("canonical policy");
  });

  it("separates preview and production target names and lifecycle", () => {
    const preview = previewGateway().targets[0];
    const production = productionGateway().targets[0];
    expect(preview?.scriptName).toBe("zevium-gateway-pr-123");
    expect(preview?.versionTag).toBe("preview-9001-1");
    expect(production?.scriptName).toBe("zevium-gateway");
    expect(production?.versionTag).toBe("ci-9002-1");
    expect(preview?.operations).toContain("deployment:create");
    expect(production?.operations).not.toContain("secret:put");
  });

  it("rejects cross-environment and malformed Convex origins", () => {
    expect(() =>
      buildManifest({
        convexSiteUrl: "https://different.convex.site",
        convexUrl: "https://preview-123.convex.cloud",
        eventName: "pull_request",
        headSha: HEAD_SHA,
        oidcSha: MERGE_SHA,
        prNumber: 123,
        profile: "preview-gateway",
        ref: "refs/pull/123/merge",
        runAttempt: 1,
        runId: "9001",
        secretDigests: PREVIEW_SECRET_DIGESTS,
      }),
    ).toThrow("deployments differ");
    expect(() =>
      buildManifest({
        eventName: "pull_request",
        headSha: HEAD_SHA,
        oidcSha: MERGE_SHA,
        profile: "production-web",
        ref: "refs/pull/123/merge",
        runAttempt: 1,
        runId: "9001",
        sourceRunId: "8999",
      }),
    ).toThrow("production requires workflow_run");
  });

  it("canonicalizes object keys and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });
});

describe("Cloudflare endpoint policy", () => {
  it.each([
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway",
      "",
      "script-read",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/secrets",
      "",
      "script-read",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts",
      "",
      "script-list-synthetic",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/settings",
      "",
      "script-read",
    ],
    [
      "POST",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions",
      "?bindings_inherit=strict",
      "version-upload",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/subdomain",
      "",
      "script-read",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/subdomain",
      "",
      "script-read",
    ],
  ])(
    "allows observed Wrangler transcript %s %s",
    (method, path, query, kind) => {
      expect(
        authorizeApiRoute(productionGateway(), method, path, query).kind,
      ).toBe(kind);
    },
  );

  it.each([
    "/accounts/WRONG/workers/scripts/zevium-gateway/settings",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/../zevium-gateway",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/%7aevium-gateway",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-deploy-broker",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/routes",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway%2fsecrets",
  ])("rejects escaped path %s", (path) => {
    expect(() =>
      authorizeApiRoute(productionGateway(), "GET", path, ""),
    ).toThrow();
  });

  it("rejects query smuggling and wrong methods", () => {
    const path =
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions";
    expect(() =>
      authorizeApiRoute(
        productionGateway(),
        "POST",
        path,
        "?bindings_inherit=strict&foo=bar",
      ),
    ).toThrow("query");
    expect(() =>
      authorizeApiRoute(productionGateway(), "PATCH", path, ""),
    ).toThrow("method");
  });
});

describe("mutation metadata", () => {
  const previewTarget = previewGateway().targets[0]!;
  const productionTarget = productionGateway().targets[0]!;

  it("accepts only exact Worker bindings, migration, and version tag", () => {
    const metadata = {
      annotations: { "workers/tag": "ci-9002-1" },
      bindings: [
        {
          name: "CONVEX_SITE_URL",
          text: "https://polite-ermine-809.convex.site",
          type: "plain_text",
        },
        {
          name: "CONVEX_URL",
          text: "https://polite-ermine-809.convex.cloud",
          type: "plain_text",
        },
        {
          class_name: "WalletDO",
          name: "WALLET",
          type: "durable_object_namespace",
        },
      ],
      compatibility_date: "2025-04-01",
      compatibility_flags: ["global_fetch_strictly_public"],
      keep_bindings: ["secret_text", "secret_key"],
      main_module: "index.js",
      migrations: {
        new_tag: "v1",
        steps: [{ new_sqlite_classes: ["WalletDO"] }],
      },
    };
    expect(
      validateWorkerMetadata(metadata, productionTarget, "version"),
    ).toEqual({
      mainModule: "index.js",
      migrationMode: "initial",
    });
    expect(() =>
      validateWorkerMetadata(
        {
          ...metadata,
          bindings: [
            ...metadata.bindings,
            { name: "EVIL", text: "1", type: "plain_text" },
          ],
        },
        productionTarget,
        "version",
      ),
    ).toThrow("bindings");
    expect(() =>
      validateWorkerMetadata(
        { ...metadata, migrations: { new_tag: "v2", steps: [] } },
        productionTarget,
        "version",
      ),
    ).toThrow("migration");
    expect(
      validateWorkerMetadata(
        { ...metadata, migrations: undefined },
        productionTarget,
        "version",
      ),
    ).toEqual({ mainModule: "index.js", migrationMode: "none" });
  });

  it("bounds secrets, traffic, and asset manifests", () => {
    expect(
      validateSecretBody(
        { name: "CLERK_SECRET_KEY", text: "redacted", type: "secret_text" },
        previewTarget,
      ).mutationKey,
    ).toContain("CLERK_SECRET_KEY");
    expect(() =>
      validateSecretBody(
        { name: "CLOUDFLARE_API_TOKEN", text: "evil", type: "secret_text" },
        previewTarget,
      ),
    ).toThrow("Secret");
    expect(() =>
      validateDeploymentBody(
        {
          annotations: {},
          strategy: "percentage",
          versions: [
            {
              percentage: 10,
              version_id: "11111111-1111-4111-8111-111111111111",
            },
          ],
        },
        productionTarget,
      ),
    ).toThrow("traffic");
    expect(() =>
      validateAssetInitBody({
        manifest: { "/../escape": { hash: "a".repeat(32), size: 1 } },
      }),
    ).toThrow("Asset manifest");

    expect(
      validateAssetInitBody({
        manifest: {
          "/copy-a.js": { hash: "b".repeat(32), size: 42 },
          "/copy-b.js": { hash: "b".repeat(32), size: 42 },
        },
      }),
    ).toEqual({ hashes: { ["b".repeat(32)]: 42 }, totalBytes: 42 });
    expect(() =>
      validateAssetInitBody({
        manifest: {
          "/copy-a.js": { hash: "b".repeat(32), size: 42 },
          "/copy-b.js": { hash: "b".repeat(32), size: 43 },
        },
      }),
    ).toThrow("one size");
  });
});
