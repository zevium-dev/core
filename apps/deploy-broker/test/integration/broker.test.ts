import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, { type BrokerEnv } from "../../src/index";
import {
  AUDIENCE_PREFIX,
  buildManifest,
  manifestDigest,
} from "../../src/manifest";
import {
  HEAD_SHA,
  MERGE_SHA,
  PREVIEW_SECRET_DIGESTS,
  TEST_ASSET_BYTES,
  TEST_CLERK_SECRET,
  TEST_GATEWAY_SECRET,
  TEST_MODULE_ARTIFACTS,
  TEST_STATIC_ASSETS,
  previewClaims,
  signClaims,
  stagingClaims,
} from "../fixtures";

const FAILED_STAGING_DEPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
const FAILED_STAGING_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const PRIOR_STAGING_DEPLOYMENT_ID = "88888888-8888-4888-8888-888888888888";
const PRIOR_STAGING_VERSION_ID = "99999999-9999-4999-8999-999999999999";
const RECOVERY_STAGING_DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SECOND_ASSET = {
  bytes: new TextEncoder().encode("second bound asset"),
  cloudflareHash: "c".repeat(32),
  contentType: "text/css; charset=utf-8",
  path: "/copy.css",
  sha256: "7ec4529b61cf71d8e3c8f81d6d14b5fa21f02b952762b7afd259fe1235fadcd3",
  size: 18,
};

function previewManifest(
  profile: "preview-cleanup" | "preview-gateway" | "preview-web",
) {
  return buildManifest({
    ...(profile === "preview-gateway" || profile === "preview-web"
      ? TEST_MODULE_ARTIFACTS
      : {}),
    ...(profile === "preview-web"
      ? {
          staticAssets: [...TEST_STATIC_ASSETS.staticAssets, SECOND_ASSET],
        }
      : {}),
    ...(profile === "preview-gateway"
      ? {
          convexSiteUrl: "https://preview-123.convex.site",
          convexUrl: "https://preview-123.convex.cloud",
        }
      : {}),
    eventName: "pull_request",
    headSha: HEAD_SHA,
    oidcSha: MERGE_SHA,
    prNumber: 123,
    profile,
    ref: "refs/pull/123/merge",
    runAttempt: 1,
    runId: "9001",
    ...(profile === "preview-gateway"
      ? { secretDigests: PREVIEW_SECRET_DIGESTS }
      : profile === "preview-web"
        ? { secretDigests: [PREVIEW_SECRET_DIGESTS[0]!] }
        : {}),
  });
}

async function dispatch(request: Request): Promise<Response> {
  const context = createExecutionContext();
  return worker.fetch(request, env as BrokerEnv, context);
}

async function register(
  profile:
    "preview-cleanup" | "preview-gateway" | "preview-web" = "preview-gateway",
) {
  const manifest = previewManifest(profile);
  return registerExact(manifest, previewClaims);
}

async function registerExact(
  manifest: ReturnType<typeof buildManifest>,
  claimsFactory: typeof previewClaims | typeof stagingClaims,
) {
  const digest = await manifestDigest(manifest);
  const token = await signClaims(claimsFactory(`${AUDIENCE_PREFIX}${digest}`));
  const response = await dispatch(
    new Request("https://deploy-broker.zevium.dev/v1/manifest", {
      body: JSON.stringify(manifest),
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.20",
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  const value = (await response.json()) as Record<string, unknown>;
  return { digest, manifest, response, token, value };
}

function gatewayVersionBody(
  includeMigration: boolean,
  clerkSecret = TEST_CLERK_SECRET,
  gatewaySecret = TEST_GATEWAY_SECRET,
): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = "----zevium-integration-version";
  const metadata = {
    annotations: { "workers/tag": "preview-9001-1" },
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
      {
        name: "CLERK_SECRET_KEY",
        text: clerkSecret,
        type: "secret_text",
      },
      {
        name: "GATEWAY_INTERNAL_SECRET",
        text: gatewaySecret,
        type: "secret_text",
      },
      { name: "CF_VERSION_METADATA", type: "version_metadata" },
    ],
    compatibility_date: "2025-04-01",
    compatibility_flags: ["global_fetch_strictly_public"],
    main_module: "index.js",
    ...(includeMigration
      ? {
          migrations: {
            new_tag: "v1",
            steps: [{ new_sqlite_classes: ["WalletDO"] }],
          },
        }
      : {}),
  };
  const source = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Disposition: form-data; name="index.js"; filename="index.js"',
    "Content-Type: application/javascript+module",
    "",
    "export default { fetch() { return new Response('ok') } }",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    body: new TextEncoder().encode(source),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function webVersionBody(assetJwt: string): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = "----zevium-integration-web-version";
  const metadata = {
    annotations: { "workers/tag": "preview-9001-1" },
    assets: { config: {}, jwt: assetJwt },
    bindings: [
      {
        name: "CLERK_SECRET_KEY",
        text: TEST_CLERK_SECRET,
        type: "secret_text",
      },
      { name: "CF_VERSION_METADATA", type: "version_metadata" },
    ],
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    main_module: "index.js",
  };
  const source = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Disposition: form-data; name="index.js"; filename="index.js"',
    "Content-Type: application/javascript+module",
    "",
    "export default { fetch() { return new Response('ok') } }",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    body: new TextEncoder().encode(source),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function bulkAssetBody(
  hash: string,
  bytes: Uint8Array,
  contentType: string,
): FormData {
  const form = new FormData();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  form.append(hash, new Blob([btoa(binary)], { type: contentType }), hash);
  return form;
}

afterEach(async () => {
  await reset();
});

describe("workerd deployment broker", () => {
  it("registers cryptographic OIDC session in real Durable Object storage", async () => {
    const registration = await register();
    expect(registration.response.status).toBe(201);
    expect(registration.value.apiBaseUrl).toMatch(
      /^https:\/\/deploy-broker\.zevium\.dev\/sessions\/[0-9a-f]{64}\/client\/v4$/,
    );
    expect(registration.value.manifestDigest).toBe(registration.digest);
    expect(JSON.stringify(registration.value)).not.toContain(
      registration.token,
    );
  });

  it("registers same signed manifest/JTI idempotently", async () => {
    const registration = await register();
    const repeated = await dispatch(
      new Request("https://deploy-broker.zevium.dev/v1/manifest", {
        body: JSON.stringify(registration.manifest),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "cf-connecting-ip": "203.0.113.20",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(repeated.status).toBe(200);
    const value = (await repeated.json()) as Record<string, unknown>;
    expect(value.apiBaseUrl).toBe(registration.value.apiBaseUrl);
  });

  it("uses broker token upstream and returns minimal lifecycle state", async () => {
    const registration = await register("preview-gateway");
    const base = String(registration.value.apiBaseUrl);
    const response = await dispatch(
      new Request(
        `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway-pr-123`,
        { headers: { authorization: `Bearer ${registration.token}` } },
      ),
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as {
      result: { default_environment: { script: { migration_tag: string } } };
    };
    expect(value.result).toEqual({
      default_environment: { script: { migration_tag: "v1" } },
    });
    expect(JSON.stringify(value)).not.toContain("authorization");
    expect(JSON.stringify(value)).not.toContain(registration.token);
    expect(JSON.stringify(value)).not.toContain("cf-test-broker-token");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("x-upstream-secret")).toBeNull();
  });

  it("rejects obsolete account-wide script inventory", async () => {
    const registration = await register("preview-gateway");
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts`,
        { headers: { authorization: `Bearer ${registration.token}` } },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("endpoint_rejected");
  });

  it("permits only no-op migration metadata after remote WalletDO v1", async () => {
    const registration = await register("preview-gateway");
    const url = `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`;
    const initial = gatewayVersionBody(true);
    const rejected = await dispatch(
      new Request(url, {
        body: initial.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": initial.contentType,
        },
        method: "POST",
      }),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toContain("migration_state_rejected");

    const noOp = gatewayVersionBody(false);
    const accepted = await dispatch(
      new Request(url, {
        body: noOp.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": noOp.contentType,
        },
        method: "POST",
      }),
    );
    expect(accepted.status).toBe(200);
  });

  it("seals asset JWT only after every provider-requested hash uploads", async () => {
    const registration = await register("preview-web");
    const base = String(registration.value.apiBaseUrl);
    const account = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers`;
    const initial = await dispatch(
      new Request(
        `${account}/scripts/zevium-web-pr-123/assets-upload-session`,
        {
          body: JSON.stringify({
            manifest: {
              "/copy.css": {
                hash: SECOND_ASSET.cloudflareHash,
                size: SECOND_ASSET.size,
              },
              "/copy.js": {
                hash: TEST_STATIC_ASSETS.staticAssets[0]!.cloudflareHash,
                size: TEST_STATIC_ASSETS.staticAssets[0]!.size,
              },
            },
          }),
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      ),
    );
    expect(initial.status).toBe(200);

    const first = TEST_STATIC_ASSETS.staticAssets[0]!;
    const firstUpload = await dispatch(
      new Request(`${account}/assets/upload?base64=true`, {
        body: bulkAssetBody(
          first.cloudflareHash,
          TEST_ASSET_BYTES,
          first.contentType,
        ),
        headers: { authorization: "Bearer asset.initial.jwt" },
        method: "POST",
      }),
    );
    expect(firstUpload.status).toBe(200);

    const version = webVersionBody("asset-completion-token.segment.signature");
    const versionUrl = `${account}/scripts/zevium-web-pr-123/versions`;
    const premature = await dispatch(
      new Request(versionUrl, {
        body: version.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": version.contentType,
        },
        method: "POST",
      }),
    );
    expect(premature.status).toBe(400);
    expect(await premature.text()).toContain("assets_rejected");

    const finalUpload = await dispatch(
      new Request(`${account}/assets/upload?base64=true`, {
        body: bulkAssetBody(
          SECOND_ASSET.cloudflareHash,
          SECOND_ASSET.bytes,
          SECOND_ASSET.contentType,
        ),
        headers: { authorization: "Bearer asset.initial.jwt" },
        method: "POST",
      }),
    );
    expect(finalUpload.status).toBe(200);

    const sealed = await dispatch(
      new Request(versionUrl, {
        body: version.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": version.contentType,
        },
        method: "POST",
      }),
    );
    expect(sealed.status, await sealed.clone().text()).toBe(200);
  });

  it("supports Cloudflare JWT-selected single-asset uploads with exact bytes", async () => {
    const registration = await register("preview-web");
    const base = String(registration.value.apiBaseUrl);
    const account = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers`;
    const initial = await dispatch(
      new Request(
        `${account}/scripts/zevium-web-pr-123/assets-upload-session`,
        {
          body: JSON.stringify({
            manifest: {
              "/copy.css": {
                hash: SECOND_ASSET.cloudflareHash,
                size: SECOND_ASSET.size,
              },
              "/copy.js": {
                hash: TEST_STATIC_ASSETS.staticAssets[0]!.cloudflareHash,
                size: TEST_STATIC_ASSETS.staticAssets[0]!.size,
              },
            },
          }),
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": "application/json",
            "user-agent": "single-assets-test",
          },
          method: "POST",
        },
      ),
    );
    expect(initial.status).toBe(200);
    const initialValue = (await initial.json()) as {
      result: { jwt: string };
    };
    const assetJwt = initialValue.result.jwt;

    const first = TEST_STATIC_ASSETS.staticAssets[0]!;
    const tampered = await dispatch(
      new Request(`${account}/assets/upload/${first.cloudflareHash}`, {
        body: new Uint8Array(first.size).fill(0),
        headers: {
          authorization: `Bearer ${assetJwt}`,
          "content-length": String(first.size),
          "content-type": first.contentType,
        },
        method: "POST",
      }),
    );
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).toContain("artifact_rejected");

    for (const asset of [
      { ...first, bytes: TEST_ASSET_BYTES },
      { ...SECOND_ASSET, bytes: SECOND_ASSET.bytes },
    ]) {
      const upload = await dispatch(
        new Request(`${account}/assets/upload/${asset.cloudflareHash}`, {
          body: asset.bytes,
          headers: {
            authorization: `Bearer ${assetJwt}`,
            "content-length": String(asset.bytes.byteLength),
            "content-type": asset.contentType,
          },
          method: "POST",
        }),
      );
      expect(upload.status, await upload.clone().text()).toBe(200);
    }

    const version = webVersionBody("asset-completion-token.segment.signature");
    const sealed = await dispatch(
      new Request(`${account}/scripts/zevium-web-pr-123/versions`, {
        body: version.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": version.contentType,
        },
        method: "POST",
      }),
    );
    expect(sealed.status, await sealed.clone().text()).toBe(200);
  });

  it("waits for delayed immutable version visibility", async () => {
    const registration = await register("preview-gateway");
    const version = gatewayVersionBody(false);
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`,
        {
          body: version.body,
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": version.contentType,
            "user-agent": "delayed-version-readback",
          },
          method: "POST",
        },
      ),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { id: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("resumes version readback without repeating successful provider mutation", async () => {
    const registration = await register("preview-gateway");
    const version = gatewayVersionBody(false);
    const url = `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`;
    const request = () =>
      new Request(url, {
        body: version.body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": version.contentType,
          "user-agent": "resume-version-readback",
        },
        method: "POST",
      });
    const pending = await dispatch(request());
    expect(pending.status).toBe(503);
    expect(await pending.text()).toContain("version_verification_pending");

    const resumed = await dispatch(request());
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect(await resumed.json()).toMatchObject({
      result: { id: "44444444-4444-4444-8444-444444444444" },
    });
  });

  it("forwards only fully validated canonical multipart with exact length", async () => {
    const registration = await register("preview-gateway");
    const version = gatewayVersionBody(false);
    const body = new TextEncoder().encode(
      new TextDecoder()
        .decode(version.body)
        .replaceAll("Content-Disposition:", "content-disposition:    "),
    );
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`,
        {
          body: Uint8Array.from(body).buffer,
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-length": String(body.byteLength),
            "content-type": version.contentType,
          },
          method: "POST",
        },
      ),
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as { result: { id: string } };
    expect(value.result).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("activates only broker-sealed exact version and verifies 100% post-state", async () => {
    const registration = await register("preview-gateway");
    const base = String(registration.value.apiBaseUrl);
    const deploymentUrl = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/deployments`;
    const deploymentBody = (versionId: string) =>
      JSON.stringify({
        annotations: { "workers/message": "integration exact publish" },
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
      });
    const beforeSeal = await dispatch(
      new Request(deploymentUrl, {
        body: deploymentBody("11111111-1111-4111-8111-111111111111"),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(beforeSeal.status).toBe(409);
    expect(await beforeSeal.text()).toContain("version_not_sealed");

    const version = gatewayVersionBody(false);
    const upload = await dispatch(
      new Request(
        `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`,
        {
          body: version.body,
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": version.contentType,
          },
          method: "POST",
        },
      ),
    );
    expect(upload.status).toBe(200);

    const wrong = await dispatch(
      new Request(deploymentUrl, {
        body: deploymentBody("22222222-2222-4222-8222-222222222222"),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("version_not_sealed");

    const exact = await dispatch(
      new Request(deploymentUrl, {
        body: deploymentBody("11111111-1111-4111-8111-111111111111"),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({
      result: { id: "22222222-2222-4222-8222-222222222222" },
      success: true,
    });
  });

  it("resumes deployment readback without creating duplicate traffic mutation", async () => {
    const registration = await register("preview-gateway");
    const base = String(registration.value.apiBaseUrl);
    const version = gatewayVersionBody(false);
    const versionResponse = await dispatch(
      new Request(
        `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`,
        {
          body: version.body,
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": version.contentType,
          },
          method: "POST",
        },
      ),
    );
    expect(versionResponse.status).toBe(200);

    const url = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/deployments`;
    const body = JSON.stringify({
      annotations: { "workers/message": "recoverable exact deployment" },
      strategy: "percentage",
      versions: [
        {
          percentage: 100,
          version_id: "11111111-1111-4111-8111-111111111111",
        },
      ],
    });
    const request = () =>
      new Request(url, {
        body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
          "user-agent": "resume-deployment-readback",
        },
        method: "POST",
      });
    const pending = await dispatch(request());
    expect(pending.status).toBe(503);
    expect(await pending.text()).toContain("deployment_verification_pending");

    const resumed = await dispatch(request());
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect(await resumed.json()).toMatchObject({
      result: { id: "55555555-5555-4555-8555-555555555555" },
    });
  });

  it("recovers only provider-proven immediately-prior lifecycle-compatible staging version", async () => {
    const recoveryInput: Parameters<typeof buildManifest>[0] = {
      convexSiteUrl: "https://zevium-stage.convex.site",
      convexUrl: "https://zevium-stage.convex.cloud",
      eventName: "workflow_dispatch",
      headSha: HEAD_SHA,
      oidcSha: HEAD_SHA,
      profile: "staging-gateway",
      recovery: {
        failedDeploymentId: FAILED_STAGING_DEPLOYMENT_ID,
        failedManifestDigest: "d".repeat(64),
        failedVersionId: FAILED_STAGING_VERSION_ID,
        priorDeploymentId: PRIOR_STAGING_DEPLOYMENT_ID,
        priorVersionId: PRIOR_STAGING_VERSION_ID,
        sourceReceiptDigest: "e".repeat(64),
      },
      ref: "refs/heads/develop",
      runAttempt: 1,
      runId: "9003",
      secretDigests: PREVIEW_SECRET_DIGESTS,
      sourceRunId: "8999",
    };
    const manifest = buildManifest(recoveryInput);
    const registration = await registerExact(manifest, stagingClaims);
    expect(registration.response.status).toBe(201);
    const url = `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-staging/deployments`;
    const body = JSON.stringify({
      annotations: { "workers/message": "provider-proven staging recovery" },
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: PRIOR_STAGING_VERSION_ID }],
    });
    const recovered = await dispatch(
      new Request(url, {
        body,
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await recovered.json()).toMatchObject({
      result: {
        id: RECOVERY_STAGING_DEPLOYMENT_ID,
        recovery_mode: "redeployed_prior",
        recovery_release_sha: "d".repeat(40),
      },
    });

    const secondManifest = buildManifest(recoveryInput);
    const second = await registerExact(secondManifest, stagingClaims);
    const noOp = await dispatch(
      new Request(
        `${second.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-staging/deployments`,
        {
          body,
          headers: {
            authorization: `Bearer ${second.token}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      ),
    );
    expect(noOp.status, await noOp.clone().text()).toBe(200);
    expect(await noOp.json()).toMatchObject({
      result: {
        id: RECOVERY_STAGING_DEPLOYMENT_ID,
        recovery_mode: "already_active",
        recovery_release_sha: "d".repeat(40),
      },
    });
  });

  it("rejects Cloudflare redirects without exposing Location", async () => {
    const registration = await register();
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway-pr-123`,
        {
          headers: {
            authorization: `Bearer ${registration.token}`,
            "user-agent": "redirect-test",
          },
        },
      ),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("upstream_redirect_rejected");
  });

  it("rejects replayed mutation before second upstream request", async () => {
    const registration = await register();
    const base = String(registration.value.apiBaseUrl);
    const url = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/subdomain`;
    const first = await dispatch(
      new Request(url, {
        body: JSON.stringify({
          enabled: true,
          previews_enabled: true,
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(first.status).toBe(200);
    const replay = await dispatch(
      new Request(url, {
        body: JSON.stringify({
          enabled: true,
          previews_enabled: true,
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("mutation_replay_rejected");
  });

  it("rejects alternate value for a signed secret before upload", async () => {
    const registration = await register();
    const version = gatewayVersionBody(
      false,
      "attacker-substitution",
      TEST_GATEWAY_SECRET,
    );
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions`,
        {
          body: version.body,
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": version.contentType,
          },
          method: "POST",
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("secret_rejected");
  });

  it.each([
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/../zevium-gateway-pr-123",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/%2e%2e/zevium-gateway-pr-123",
    "/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-deploy-broker",
    "/accounts/ffffffffffffffffffffffffffffffff/workers/scripts/zevium-gateway-pr-123",
  ])("rejects path escape without outbound request: %s", async (suffix) => {
    const registration = await register();
    const response = await dispatch(
      new Request(`${registration.value.apiBaseUrl}${suffix}`, {
        headers: { authorization: `Bearer ${registration.token}` },
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects token from another OIDC jti/session and cross-environment claims", async () => {
    const registration = await register();
    const base = String(registration.value.apiBaseUrl);
    const route = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway-pr-123`;
    const otherJti = await signClaims(
      previewClaims(`${AUDIENCE_PREFIX}${registration.digest}`),
    );
    const response = await dispatch(
      new Request(route, { headers: { authorization: `Bearer ${otherJti}` } }),
    );
    expect(response.status).toBe(401);

    const crossEnvironment = await signClaims(
      previewClaims(`${AUDIENCE_PREFIX}${registration.digest}`, {
        environment: "production",
        sub: "repo:zevium-dev/core:environment:production",
      }),
    );
    const crossResponse = await dispatch(
      new Request(route, {
        headers: { authorization: `Bearer ${crossEnvironment}` },
      }),
    );
    expect(crossResponse.status).toBe(403);
  });

  it("rate-limits forged dry-run tokens before unbounded JWKS verification", async () => {
    const manifest = previewManifest("preview-gateway");
    const digest = await manifestDigest(manifest);
    const token = await signClaims(
      previewClaims(`${AUDIENCE_PREFIX}${digest}`),
    );
    const parts = token.split(".");
    const signature = parts[2] ?? "";
    parts[2] = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const forged = parts.join(".");
    for (let index = 0; index < 6; index += 1) {
      const response = await dispatch(
        new Request("https://deploy-broker.zevium.dev/v1/manifest/dry-run", {
          body: JSON.stringify(manifest),
          headers: {
            authorization: `Bearer ${forged}`,
            "cf-connecting-ip": "203.0.113.88",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(401);
    }
    const limited = await dispatch(
      new Request("https://deploy-broker.zevium.dev/v1/manifest/dry-run", {
        body: JSON.stringify(manifest),
        headers: {
          authorization: `Bearer ${forged}`,
          "cf-connecting-ip": "203.0.113.88",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(limited.status).toBe(429);
  });

  it("fails closed on missing broker credential", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://deploy-broker.zevium.dev/health"),
      { ...env, CLOUDFLARE_BROKER_API_TOKEN: undefined } as BrokerEnv,
      context,
    );
    expect(response.status).toBe(503);
  });
});
