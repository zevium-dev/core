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
  TEST_MODULE_ARTIFACTS,
  previewClaims,
  signClaims,
} from "../fixtures";

function previewManifest(profile: "preview-cleanup" | "preview-gateway") {
  return buildManifest({
    ...(profile === "preview-gateway" ? TEST_MODULE_ARTIFACTS : {}),
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
      : {}),
  });
}

async function dispatch(request: Request): Promise<Response> {
  const context = createExecutionContext();
  return worker.fetch(request, env as BrokerEnv, context);
}

async function register(
  profile: "preview-cleanup" | "preview-gateway" = "preview-gateway",
) {
  const manifest = previewManifest(profile);
  const digest = await manifestDigest(manifest);
  const token = await signClaims(previewClaims(`${AUDIENCE_PREFIX}${digest}`));
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

function gatewayVersionBody(includeMigration: boolean): {
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
    ],
    compatibility_date: "2025-04-01",
    compatibility_flags: ["global_fetch_strictly_public"],
    keep_bindings: ["secret_text", "secret_key"],
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

  it("uses broker token upstream, strips response secrets, and streams response", async () => {
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
      result: { authorization: string; pathname: string };
    };
    expect(value.result.authorization).toBe("Bearer cf-test-broker-token");
    expect(value.result.authorization).not.toContain(registration.token);
    expect(value.result.pathname).toBe(
      "/client/v4/accounts/1ea9299555b026a6a7484c8323c5a953/workers/services/zevium-gateway-pr-123",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("x-upstream-secret")).toBeNull();
  });

  it("synthesizes target-only script state from exact service probes", async () => {
    const registration = await register("preview-gateway");
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts`,
        { headers: { authorization: `Bearer ${registration.token}` } },
      ),
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as {
      result: Array<{ id: string; migration_tag?: string }>;
    };
    expect(value.result).toEqual([
      { id: "zevium-gateway-pr-123", migration_tag: "v1" },
    ]);
    expect(JSON.stringify(value)).not.toContain("zevium-deploy-broker");
  });

  it("permits only no-op migration metadata after remote WalletDO v1", async () => {
    const registration = await register("preview-gateway");
    const url = `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions?bindings_inherit=strict`;
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
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/versions?bindings_inherit=strict`,
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
    const value = (await response.json()) as {
      result: { bodyLength: number; contentLength: null | string };
    };
    expect(value.result.bodyLength).toBe(body.byteLength - 8);
    if (value.result.contentLength !== null) {
      expect(Number(value.result.contentLength)).toBe(value.result.bodyLength);
    }
  });

  it("rejects Cloudflare redirects without exposing Location", async () => {
    const registration = await register();
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/settings`,
        { headers: { authorization: `Bearer ${registration.token}` } },
      ),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("upstream_redirect_rejected");
  });

  it("rejects replayed mutation before second upstream request", async () => {
    const registration = await register();
    const base = String(registration.value.apiBaseUrl);
    const url = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/secrets`;
    const first = await dispatch(
      new Request(url, {
        body: JSON.stringify({
          name: "CLERK_SECRET_KEY",
          text: "redacted-test-secret",
          type: "secret_text",
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "PUT",
      }),
    );
    expect(first.status).toBe(200);
    const replay = await dispatch(
      new Request(url, {
        body: JSON.stringify({
          name: "CLERK_SECRET_KEY",
          text: "redacted-test-secret",
          type: "secret_text",
        }),
        headers: {
          authorization: `Bearer ${registration.token}`,
          "content-type": "application/json",
        },
        method: "PUT",
      }),
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("mutation_replay_rejected");
  });

  it("rejects alternate value for a signed secret name", async () => {
    const registration = await register();
    const response = await dispatch(
      new Request(
        `${registration.value.apiBaseUrl}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts/zevium-gateway-pr-123/secrets`,
        {
          body: JSON.stringify({
            name: "CLERK_SECRET_KEY",
            text: "attacker-substitution",
            type: "secret_text",
          }),
          headers: {
            authorization: `Bearer ${registration.token}`,
            "content-type": "application/json",
          },
          method: "PUT",
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
    const route = `${base}/accounts/1ea9299555b026a6a7484c8323c5a953/workers/scripts`;
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

  it("rate-limits manifest registration", async () => {
    const manifest = previewManifest("preview-gateway");
    const digest = await manifestDigest(manifest);
    const token = await signClaims(
      previewClaims(`${AUDIENCE_PREFIX}${digest}`),
    );
    let lastStatus = 0;
    for (let index = 0; index < 7; index += 1) {
      const response = await dispatch(
        new Request("https://deploy-broker.zevium.dev/v1/manifest/dry-run", {
          body: JSON.stringify(manifest),
          headers: {
            authorization: `Bearer ${token}`,
            "cf-connecting-ip": "203.0.113.88",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
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
