import { describe, expect, it } from "vitest";
import {
  authorizeApiRoute,
  validateAssetInitBody,
  validateDeploymentBody,
  validateDeploymentDetail,
  validateVersionDetail,
  validateWorkerMetadata,
} from "../../src/api-policy";
import {
  buildManifest,
  canonicalJson,
  manifestDigest,
  parseManifest,
} from "../../src/manifest";
import {
  HEAD_SHA,
  MERGE_SHA,
  PREVIEW_SECRET_DIGESTS,
  PRODUCTION_SHA,
  TEST_MODULE_ARTIFACTS,
  TEST_STATIC_ASSETS,
  TEST_ASSET_SHA256,
  TEST_WEB_SECRET_DIGESTS,
} from "../fixtures";

function previewGateway() {
  return buildManifest({
    ...TEST_MODULE_ARTIFACTS,
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
    ...TEST_MODULE_ARTIFACTS,
    eventName: "workflow_run",
    headSha: HEAD_SHA,
    oidcSha: PRODUCTION_SHA,
    profile: "production-gateway",
    ref: "refs/heads/develop",
    runAttempt: 1,
    runId: "9002",
    secretDigests: PREVIEW_SECRET_DIGESTS,
    sourceRunId: "8999",
  });
}

function stagingGateway() {
  return buildManifest({
    ...TEST_MODULE_ARTIFACTS,
    convexSiteUrl: "https://zevium-stage.convex.site",
    convexUrl: "https://zevium-stage.convex.cloud",
    eventName: "workflow_dispatch",
    headSha: HEAD_SHA,
    oidcSha: HEAD_SHA,
    profile: "staging-gateway",
    ref: "refs/heads/develop",
    runAttempt: 1,
    runId: "9003",
    secretDigests: PREVIEW_SECRET_DIGESTS,
    sourceRunId: "8999",
  });
}

describe("signed deployment manifest", () => {
  it("rebuilds policy while cryptographically binding serialized artifacts", async () => {
    const manifest = previewGateway();
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest);
    const forged = structuredClone(manifest);
    forged.targets[0]?.operations.push("script:delete");
    expect(() => parseManifest(forged)).toThrow("canonical policy");
    const executableSwap = structuredClone(manifest);
    executableSwap.targets[0]!.modules[0]!.sha256 = "f".repeat(64);
    expect(parseManifest(executableSwap).targets[0]!.modules[0]!.sha256).toBe(
      "f".repeat(64),
    );
    expect(await manifestDigest(executableSwap)).not.toEqual(
      await manifestDigest(manifest),
    );
  });

  it("separates preview and production target names and lifecycle", () => {
    const preview = previewGateway().targets[0];
    const production = productionGateway().targets[0];
    expect(preview?.scriptName).toBe("zevium-gateway-pr-123");
    expect(preview?.versionTag).toBe("preview-9001-1");
    expect(production?.scriptName).toBe("zevium-gateway");
    expect(production?.versionTag).toBe(`production-${HEAD_SHA}`);
    expect(production?.plainTextBindings).toContainEqual({
      name: "ZEVIUM_RELEASE",
      text: HEAD_SHA,
    });
    expect(production?.migrations).toEqual([
      { newSqliteClasses: ["WalletDO"], tag: "v1" },
      { newSqliteClasses: ["RegistryDO"], tag: "v2" },
      { newSqliteClasses: ["X402PaymentDO"], tag: "v3" },
    ]);
    expect(preview?.operations).toContain("deployment:create");
    expect(production?.allowedSecrets.map(({ name }) => name)).toEqual([
      "CLERK_SECRET_KEY",
      "GATEWAY_INTERNAL_SECRET",
    ]);
  });

  it("binds stable staging target to isolated Convex and full DO lifecycle", () => {
    const manifest = stagingGateway();
    const target = manifest.targets[0]!;
    expect(manifest).toMatchObject({
      environment: "staging",
      eventName: "workflow_dispatch",
      sourceRunId: "8999",
    });
    expect(target).toMatchObject({
      durableObjectBindings: [
        { className: "WalletDO", name: "WALLET" },
        { className: "RegistryDO", name: "REGISTRY" },
        { className: "X402PaymentDO", name: "X402_PAYMENTS" },
      ],
      migrations: [
        { newSqliteClasses: ["WalletDO"], tag: "v1" },
        { newSqliteClasses: ["RegistryDO"], tag: "v2" },
        { newSqliteClasses: ["X402PaymentDO"], tag: "v3" },
      ],
      scriptName: "zevium-gateway-staging",
      versionMetadataBinding: "CF_VERSION_METADATA",
      versionTag: `staging-${HEAD_SHA}`,
    });
    expect(target.plainTextBindings).toEqual([
      { name: "CONVEX_SITE_URL", text: "https://zevium-stage.convex.site" },
      { name: "CONVEX_URL", text: "https://zevium-stage.convex.cloud" },
      { name: "ZEVIUM_RELEASE", text: HEAD_SHA },
    ]);
  });

  it("rejects staging workflow or Convex production crossover", () => {
    expect(() =>
      buildManifest({
        ...TEST_MODULE_ARTIFACTS,
        convexSiteUrl: "https://zevium-stage.convex.site",
        convexUrl: "https://zevium-stage.convex.cloud",
        eventName: "workflow_run",
        headSha: HEAD_SHA,
        oidcSha: HEAD_SHA,
        profile: "staging-gateway",
        ref: "refs/heads/develop",
        runAttempt: 1,
        runId: "9003",
        secretDigests: PREVIEW_SECRET_DIGESTS,
        sourceRunId: "8999",
      }),
    ).toThrow("staging requires workflow_dispatch");
    expect(() =>
      buildManifest({
        ...TEST_MODULE_ARTIFACTS,
        convexSiteUrl: "https://polite-ermine-809.convex.site",
        convexUrl: "https://polite-ermine-809.convex.cloud",
        eventName: "workflow_dispatch",
        headSha: HEAD_SHA,
        oidcSha: HEAD_SHA,
        profile: "staging-gateway",
        ref: "refs/heads/develop",
        runAttempt: 1,
        runId: "9003",
        secretDigests: PREVIEW_SECRET_DIGESTS,
        sourceRunId: "8999",
      }),
    ).toThrow("staging cannot target production Convex");
    expect(() =>
      buildManifest({
        ...TEST_MODULE_ARTIFACTS,
        convexSiteUrl: "https://zevium-stage.convex.site",
        convexUrl: "https://zevium-stage.convex.cloud",
        eventName: "workflow_dispatch",
        headSha: HEAD_SHA,
        oidcSha: PRODUCTION_SHA,
        profile: "staging-gateway",
        ref: "refs/heads/develop",
        runAttempt: 1,
        runId: "9003",
        secretDigests: PREVIEW_SECRET_DIGESTS,
        sourceRunId: "8999",
      }),
    ).toThrow("checked-out OIDC SHA");
  });

  it("binds staging recovery selectors while removing upload authority", () => {
    const manifest = buildManifest({
      convexSiteUrl: "https://zevium-stage.convex.site",
      convexUrl: "https://zevium-stage.convex.cloud",
      eventName: "workflow_dispatch",
      headSha: HEAD_SHA,
      oidcSha: HEAD_SHA,
      profile: "staging-gateway",
      recovery: {
        failedDeploymentId: "11111111-1111-4111-8111-111111111111",
        failedManifestDigest: "d".repeat(64),
        failedVersionId: "22222222-2222-4222-8222-222222222222",
        priorDeploymentId: "33333333-3333-4333-8333-333333333333",
        priorVersionId: "44444444-4444-4444-8444-444444444444",
        sourceReceiptDigest: "e".repeat(64),
      },
      ref: "refs/heads/develop",
      runAttempt: 1,
      runId: "9003",
      secretDigests: PREVIEW_SECRET_DIGESTS,
      sourceRunId: "8999",
    });
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest);
    expect(manifest.targets[0]).toMatchObject({
      assets: false,
      mainModule: null,
      modules: [],
      operations: ["deployment:create"],
      staticAssets: [],
    });
    expect(manifest.recovery).toMatchObject({
      priorDeploymentId: "33333333-3333-4333-8333-333333333333",
      priorVersionId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("rejects cross-environment and malformed Convex origins", () => {
    expect(() =>
      buildManifest({
        ...TEST_MODULE_ARTIFACTS,
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
        ...TEST_MODULE_ARTIFACTS,
        ...TEST_STATIC_ASSETS,
        eventName: "pull_request",
        headSha: HEAD_SHA,
        oidcSha: MERGE_SHA,
        profile: "production-web",
        ref: "refs/pull/123/merge",
        runAttempt: 1,
        runId: "9001",
        sourceRunId: "8999",
        secretDigests: TEST_WEB_SECRET_DIGESTS,
      }),
    ).toThrow("production requires workflow_run");
  });

  it("canonicalizes object keys and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  it("bounds serialized manifests before Durable Object persistence", () => {
    const staticAssets = Array.from({ length: 120 }, (_, index) => ({
      cloudflareHash: index.toString(16).padStart(32, "0"),
      contentType: "text/javascript; charset=utf-8",
      path: `/${index.toString().padStart(3, "0")}-${"x".repeat(900)}.js`,
      sha256: "d".repeat(64),
      size: 1,
    }));
    expect(() =>
      buildManifest({
        ...TEST_MODULE_ARTIFACTS,
        eventName: "workflow_run",
        headSha: HEAD_SHA,
        oidcSha: PRODUCTION_SHA,
        profile: "production-web",
        ref: "refs/heads/develop",
        runAttempt: 1,
        runId: "9002",
        secretDigests: TEST_WEB_SECRET_DIGESTS,
        sourceRunId: "8999",
        staticAssets,
      }),
    ).toThrow("serialized manifest is too large");
  });
});

describe("Cloudflare endpoint policy", () => {
  it.each([
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway",
      "",
      "service-read",
    ],
    [
      "POST",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions",
      "",
      "version-upload",
    ],
    [
      "GET",
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/deployments",
      "",
      "deployment-list",
    ],
  ])("allows exact publisher route %s %s", (method, path, query, kind) => {
    expect(
      authorizeApiRoute(productionGateway(), method, path, query).kind,
    ).toBe(kind);
  });

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
    ).toThrow(Error);
  });

  it("rejects query smuggling and wrong methods", () => {
    const path =
      "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions";
    expect(() =>
      authorizeApiRoute(
        productionGateway(),
        "POST",
        path,
        "?bindings_inherit=strict",
      ),
    ).toThrow("query");
    expect(() =>
      authorizeApiRoute(productionGateway(), "PATCH", path, ""),
    ).toThrow("method");
  });

  it.each([
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/subdomain",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/settings",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/secrets",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions?deployable=true",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway/versions/11111111-1111-4111-8111-111111111111",
  ])("rejects obsolete Wrangler read surface %s", (input) => {
    const url = new URL(`https://api.cloudflare.test${input}`);
    expect(() =>
      authorizeApiRoute(productionGateway(), "GET", url.pathname, url.search),
    ).toThrow(Error);
  });
});

describe("mutation metadata", () => {
  const previewTarget = previewGateway().targets[0]!;
  const productionTarget = productionGateway().targets[0]!;

  it("accepts only exact Worker bindings, migration, and version tag", () => {
    const metadata = {
      annotations: { "workers/tag": `production-${HEAD_SHA}` },
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
        { name: "ZEVIUM_RELEASE", text: HEAD_SHA, type: "plain_text" },
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
        {
          name: "CLERK_SECRET_KEY",
          text: "redacted-clerk",
          type: "secret_text",
        },
        {
          name: "GATEWAY_INTERNAL_SECRET",
          text: "redacted-gateway",
          type: "secret_text",
        },
        { name: "CF_VERSION_METADATA", type: "version_metadata" },
      ],
      compatibility_date: "2025-04-01",
      compatibility_flags: ["global_fetch_strictly_public"],
      main_module: "index.js",
      migrations: {
        new_tag: "v3",
        steps: [
          { new_sqlite_classes: ["WalletDO"] },
          { new_sqlite_classes: ["RegistryDO"] },
          { new_sqlite_classes: ["X402PaymentDO"] },
        ],
      },
    };
    expect(
      validateWorkerMetadata(metadata, productionTarget, "version"),
    ).toEqual({
      mainModule: "index.js",
      migrationIntent: { oldTag: null },
      secretBindings: [
        { name: "CLERK_SECRET_KEY", text: "redacted-clerk" },
        { name: "GATEWAY_INTERNAL_SECRET", text: "redacted-gateway" },
      ],
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
        {
          ...metadata,
          migrations: {
            new_tag: "v3",
            old_tag: "v1",
            steps: [
              { new_sqlite_classes: ["RegistryDO"] },
              { new_sqlite_classes: ["X402PaymentDO"] },
            ],
          },
        },
        productionTarget,
        "version",
      ),
    ).toEqual({
      mainModule: "index.js",
      migrationIntent: { oldTag: "v1" },
      secretBindings: [
        { name: "CLERK_SECRET_KEY", text: "redacted-clerk" },
        { name: "GATEWAY_INTERNAL_SECRET", text: "redacted-gateway" },
      ],
    });
    expect(
      validateWorkerMetadata(
        { ...metadata, migrations: undefined },
        productionTarget,
        "version",
      ),
    ).toMatchObject({ migrationIntent: null });
  });

  it("bounds secrets, traffic, and asset manifests", () => {
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
      validateAssetInitBody(
        {
          manifest: { "/../escape": { hash: "a".repeat(32), size: 1 } },
        },
        previewTarget,
      ),
    ).toThrow("Asset manifest");

    expect(
      validateAssetInitBody(
        {
          manifest: {
            "/copy.js": { hash: "b".repeat(32), size: 18 },
          },
        },
        { ...previewTarget, staticAssets: TEST_STATIC_ASSETS.staticAssets },
      ),
    ).toEqual({
      contentTypeByHash: {
        ["b".repeat(32)]: "text/javascript; charset=utf-8",
      },
      hashes: { ["b".repeat(32)]: 18 },
      sha256ByHash: { ["b".repeat(32)]: TEST_ASSET_SHA256 },
      totalBytes: 18,
    });
    expect(() =>
      validateAssetInitBody(
        {
          manifest: {
            "/copy.js": { hash: "b".repeat(32), size: 43 },
          },
        },
        { ...previewTarget, staticAssets: TEST_STATIC_ASSETS.staticAssets },
      ),
    ).toThrow("Asset manifest");
  });

  it("accepts only exact immutable 100% deployment readback", () => {
    const deploymentId = "22222222-2222-4222-8222-222222222222";
    const versionId = "11111111-1111-4111-8111-111111111111";
    const detail = {
      id: deploymentId,
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: versionId }],
    };
    expect(() =>
      validateDeploymentDetail(detail, deploymentId, versionId),
    ).not.toThrow();
    expect(() =>
      validateDeploymentDetail(
        {
          ...detail,
          versions: [{ percentage: 99, version_id: versionId }],
        },
        deploymentId,
        versionId,
      ),
    ).toThrow("differs from sealed version");
    expect(() =>
      validateDeploymentDetail(detail, versionId, versionId),
    ).toThrow("differs from sealed version");
  });

  it("retires undeclared web secrets instead of inheriting provider drift", () => {
    const target = buildManifest({
      ...TEST_MODULE_ARTIFACTS,
      ...TEST_STATIC_ASSETS,
      eventName: "workflow_run",
      headSha: HEAD_SHA,
      oidcSha: PRODUCTION_SHA,
      profile: "production-web",
      ref: "refs/heads/develop",
      runAttempt: 1,
      runId: "9002",
      secretDigests: TEST_WEB_SECRET_DIGESTS,
      sourceRunId: "8999",
    }).targets[0]!;
    const metadata = {
      annotations: { "workers/tag": `production-${HEAD_SHA}` },
      assets: { config: {}, jwt: "a.b.c".repeat(10) },
      bindings: [
        { name: "ZEVIUM_RELEASE", text: HEAD_SHA, type: "plain_text" },
        { name: "CLERK_SECRET_KEY", text: "secret", type: "secret_text" },
        { name: "CF_VERSION_METADATA", type: "version_metadata" },
      ],
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      main_module: "index.js",
    };
    expect(validateWorkerMetadata(metadata, target, "version")).toMatchObject({
      mainModule: "index.js",
    });
    expect(() =>
      validateWorkerMetadata(
        {
          ...metadata,
          keep_bindings: ["secret_text", "secret_key"],
        },
        target,
        "version",
      ),
    ).toThrow("undeclared field");
    expect(() =>
      validateWorkerMetadata(
        {
          ...metadata,
          bindings: [
            ...metadata.bindings,
            { name: "LIBSQL_AUTH_TOKEN", text: "legacy", type: "secret_text" },
          ],
        },
        target,
        "version",
      ),
    ).toThrow("Secret binding");
  });

  it("seals only exact Cloudflare readback and rejects stale secrets", () => {
    const detail = {
      id: "11111111-1111-4111-8111-111111111111",
      resources: {
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
          { name: "ZEVIUM_RELEASE", text: HEAD_SHA, type: "plain_text" },
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
          { name: "GATEWAY_INTERNAL_SECRET", type: "secret_text" },
          { name: "CF_VERSION_METADATA", type: "version_metadata" },
        ],
        script: { etag: "a".repeat(64) },
        script_runtime: {
          compatibility_date: "2025-04-01",
          compatibility_flags: ["global_fetch_strictly_public"],
          migration_tag: "v3",
        },
      },
    };
    expect(() =>
      validateVersionDetail(
        detail,
        productionTarget,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).not.toThrow();
    expect(() =>
      validateVersionDetail(
        {
          ...detail,
          resources: {
            ...detail.resources,
            bindings: [
              ...detail.resources.bindings,
              { name: "LEGACY_SECRET", type: "secret_text" },
            ],
          },
        },
        productionTarget,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toThrow("closed");
    expect(() =>
      validateVersionDetail(
        {
          ...detail,
          resources: {
            ...detail.resources,
            script_runtime: {
              ...detail.resources.script_runtime,
              migration_tag: "legacy",
            },
          },
        },
        productionTarget,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toThrow("does not match");
  });
});
