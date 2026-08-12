import { audit } from "./audit";
import { sha256Hex } from "./crypto";
import { BROKER_ORIGIN, type BrokerEnv, validateEnvironment } from "./env";
import { BrokerError, errorResponse, invariant, jsonResponse } from "./errors";
import { bearerToken, verifyGitHubOidc } from "./jwt";
import {
  AUDIENCE_PREFIX,
  manifestDigest,
  parseManifest,
  type DeploymentManifest,
} from "./manifest";
import { verifyProvenance } from "./provenance";
import { AuthRateLimitDO, DeploySessionDO } from "./session";
import { readJsonBounded } from "./strict-json";

export { AuthRateLimitDO, DeploySessionDO };
export type { BrokerEnv } from "./env";

const SESSION_ROUTE_PATTERN =
  /^\/sessions\/([0-9a-f]{64})\/client\/v4\/[^?#]*$/;

function rawPathname(url: string): string {
  invariant(
    url.length <= 4_096 && !url.includes("#"),
    400,
    "path_rejected",
    "Request URL is invalid",
  );
  const match = /^https:\/\/[^/?#]+([^?#]*)/.exec(url);
  invariant(match, 400, "path_rejected", "Request URL is invalid");
  return match[1] || "/";
}

function registrationRateKey(request: Request): string {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!/^[0-9A-Fa-f:.]{2,64}$/.test(address)) return "unknown";
  return address.toLowerCase();
}

async function consumeRegistrationRate(
  request: Request,
  env: BrokerEnv,
): Promise<void> {
  const key = await sha256Hex(registrationRateKey(request));
  const stub = env.AUTH_RATE_LIMIT.get(env.AUTH_RATE_LIMIT.idFromName(key));
  const response = await stub.fetch("https://auth-rate.internal/consume", {
    headers: { "x-broker-internal": "1" },
    method: "POST",
  });
  if (response.status === 200) return;
  if (response.status === 429) {
    throw new BrokerError(
      429,
      "registration_rate_limited",
      "Deployment registration rate exceeded",
    );
  }
  throw new BrokerError(
    503,
    "rate_limiter_unavailable",
    "Deployment registration rate limiter failed",
  );
}

function policySummary(manifest: DeploymentManifest): Record<string, unknown> {
  return {
    accountId: manifest.accountId,
    environment: manifest.environment,
    expiresWithOidc: true,
    profile: manifest.profile,
    targets: manifest.targets.map((target) => ({
      allowedSecrets: target.allowedSecrets.map((secret) => secret.name),
      assets: target.assets,
      component: target.component,
      durableObjectBindings: target.durableObjectBindings,
      inheritedBindingTypes: target.inheritedBindingTypes,
      mainModule: target.mainModule,
      migration: target.migration,
      moduleCount: target.modules.length,
      moduleBytes: target.modules.reduce(
        (total, module) => total + module.size,
        0,
      ),
      operations: target.operations,
      plainTextBindingNames: target.plainTextBindings.map(
        (binding) => binding.name,
      ),
      scriptName: target.scriptName,
      staticAssetCount: target.staticAssets.length,
      staticAssetBytes: target.staticAssets.reduce(
        (total, asset) => total + asset.size,
        0,
      ),
      versionTag: target.versionTag,
      workersDev: target.workersDev,
    })),
  };
}

async function registerManifest(
  request: Request,
  env: BrokerEnv,
  dryRun: boolean,
): Promise<Response> {
  validateEnvironment(env, { requireCloudflareToken: !dryRun });
  await consumeRegistrationRate(request, env);
  const { value } = await readJsonBounded(request, 128 * 1024);
  const manifest = parseManifest(value);
  const digest = await manifestDigest(manifest);
  const claims = await verifyGitHubOidc(
    bearerToken(request),
    `${AUDIENCE_PREFIX}${digest}`,
  );
  await verifyProvenance(manifest, claims);

  if (dryRun) {
    audit(
      {
        decision: "allow",
        method: request.method,
        route: "manifest-dry-run",
        status: 200,
      },
      manifest,
    );
    return jsonResponse(200, {
      audience: `${AUDIENCE_PREFIX}${digest}`,
      dryRun: true,
      manifest,
      manifestDigest: digest,
      ok: true,
      policy: policySummary(manifest),
    });
  }

  const sessionId = await sha256Hex(`${claims.jti}\0${digest}`);
  const jtiHash = await sha256Hex(claims.jti);
  const expiresAt = claims.exp * 1_000;
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  const response = await stub.fetch(
    "https://deploy-session.internal/register",
    {
      body: JSON.stringify({
        digest,
        expiresAt,
        jtiHash,
        manifest,
        sessionId,
      }),
      headers: {
        "content-type": "application/json",
        "x-broker-internal": "1",
      },
      method: "POST",
    },
  );
  invariant(
    response.status === 200 || response.status === 201,
    response.status === 409 ? 409 : 503,
    response.status === 409 ? "session_replay_rejected" : "session_unavailable",
    response.status === 409
      ? "Deployment session identifier is already bound"
      : "Deployment session could not be created",
  );
  audit(
    {
      decision: "allow",
      method: request.method,
      route: "manifest",
      sessionId,
      status: response.status,
    },
    manifest,
  );
  return jsonResponse(response.status, {
    apiBaseUrl: `${BROKER_ORIGIN}/sessions/${sessionId}/client/v4`,
    expiresAt,
    manifestDigest: digest,
    ok: true,
    policy: policySummary(manifest),
    sessionId,
    tokenTransport: "GitHub OIDC via Wrangler CLOUDFLARE_API_TOKEN variable",
  });
}

export default {
  async fetch(request: Request, env: BrokerEnv): Promise<Response> {
    let manifest: DeploymentManifest | undefined;
    try {
      const url = new URL(request.url);
      invariant(
        url.origin === BROKER_ORIGIN,
        421,
        "origin_rejected",
        "Deployment broker origin is invalid",
      );
      const pathname = rawPathname(request.url);
      if (
        request.method === "GET" &&
        pathname === "/health" &&
        url.search === ""
      ) {
        validateEnvironment(env, { requireCloudflareToken: true });
        return jsonResponse(200, {
          ok: true,
          service: "zevium-deploy-broker",
        });
      }

      if (
        request.method === "POST" &&
        url.search === "" &&
        (pathname === "/v1/manifest" || pathname === "/v1/manifest/dry-run")
      ) {
        return await registerManifest(
          request,
          env,
          pathname === "/v1/manifest/dry-run",
        );
      }

      const sessionMatch = SESSION_ROUTE_PATTERN.exec(pathname);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        invariant(
          sessionId,
          404,
          "session_route_rejected",
          "Deployment session route is invalid",
        );
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
        return await stub.fetch(request);
      }

      throw new BrokerError(
        404,
        "route_not_found",
        "Deployment broker route does not exist",
      );
    } catch (error) {
      audit(
        {
          code: error instanceof BrokerError ? error.code : "internal_error",
          decision: "deny",
          method: request.method,
          status: error instanceof BrokerError ? error.status : 500,
        },
        manifest,
      );
      return errorResponse(error);
    }
  },
};
