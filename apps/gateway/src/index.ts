import { llmsResponse } from "@zevium/shared";
import { handleListingDocs } from "./generated-contract";
import { nextConnectionsDeps, nextDeps } from "./next/pipeline";
import { wakeWallet, readWalletFailure } from "./next/wake";
import type { NextEnv } from "./next/snapshots";
export { EdgeOAuthDO } from "./next/oauth";
export { EdgeSnapshotDO } from "./next/snapshots";
export { NextWalletDO } from "./next/wallet";
import type { CatalogueSearchSource } from "./catalogue-search";
import {
  oauthConfig,
  oauthChallenge,
  protectedResourceMetadata,
  type McpOAuthVerifier,
} from "./mcp-oauth";
import { extractApiKey } from "./key-verifier";
import type { PublicSpecSource } from "./spec-source";
import type { CatalogueSource } from "./catalogue-source";
import {
  handleGatewayRequest,
  parseGatewayPath,
  type PipelineDeps,
} from "./pipeline";
import { handleDiscoveryRequest, type DiscoveryDeps } from "./discovery";
import { handleMcpRequest, type McpDeps } from "./mcp";
import { corsPreflight } from "./cors";
import { jsonError } from "./errors";
import { webOrigin } from "./web-origin";
import { handleMockRequest, parseMockPath, type MockDeps } from "./mock";
import { handleConnectionsRequest, type ConnectionsDeps } from "./connections";

import { applyGatewaySecurityHeaders } from "./security-headers";

export interface Env extends NextEnv {
  /** Paired web application origin for payment recovery actions. */
  APP_ORIGIN?: string;
  CLERK_SECRET_KEY?: string;
  /** Enable OAuth with the Clerk Frontend API origin and canonical /mcp URL. */
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_RESOURCE?: string;
  CONVEX_URL?: string;
  /** Convex .convex.site origin for httpActions (ingest-usage). */
  CONVEX_SITE_URL?: string;
  /** Shared secret for paired snapshot, wake and settlement HTTP. */
  GATEWAY_INTERNAL_SECRET?: string;
  /** Immutable git SHA stamped into every release candidate. */
  ZEVIUM_RELEASE?: string;
  /** Cloudflare-owned immutable version metadata binding. */
  CF_VERSION_METADATA?: {
    id: string;
    tag: string;
    timestamp: string;
  };
  /**
   * Test-only: when set, Worker uses fixture key/spec sources populated via
   * internal test helpers (see test/pipeline.test.ts). Not for production.
   */
  GATEWAY_TEST_MODE?: string;
}

/** Full worker deps: pipeline + catalogue for discovery/MCP. */
export type WorkerDeps = PipelineDeps & {
  catalogueSource: CatalogueSource;
  searchSource?: CatalogueSearchSource;
  oauthVerifier?: McpOAuthVerifier;
  /** Credential-free source for discovery, docs, and keyless mocks. */
  publicSpecSource: PublicSpecSource;
  /** Test-only override for `/connections`; production builds it from env. */
  connectionsDeps?: ConnectionsDeps;
};

// Test-mode singletons (module scope per isolate). Production never sets GATEWAY_TEST_MODE.
let testDeps: WorkerDeps | null = null;

/** Test harness installs fixture deps before calling fetch. */
export function __setTestPipelineDeps(deps: WorkerDeps | null): void {
  testDeps = deps;
}

export function __getTestPipelineDeps(): WorkerDeps | null {
  return testDeps;
}

function gatewayDeploymentProof(env: Env) {
  return {
    schema: "zevium.cloudflare-runtime/v1",
    service: "gateway",
    gitSha: env.ZEVIUM_RELEASE ?? "",
    versionId: env.CF_VERSION_METADATA?.id ?? "",
    versionTag: env.CF_VERSION_METADATA?.tag ?? "",
    deployedAt: env.CF_VERSION_METADATA?.timestamp ?? "",
  } as const;
}

function validGatewayDeploymentProof(
  proof: ReturnType<typeof gatewayDeploymentProof>,
): boolean {
  const deployedAt = Date.parse(proof.deployedAt);
  const legacyTag =
    /^(?:preview-[1-9][0-9]*-[0-9a-f]{40}|(?:staging|production)-[0-9a-f]{40})$/.test(
      proof.versionTag,
    ) && proof.versionTag.endsWith(proof.gitSha);
  const attemptTag = proof.versionTag.match(
    /^production-([0-9a-f]{40})-[1-9][0-9]*-[1-9][0-9]*$/,
  );
  return (
    /^[0-9a-f]{40}$/.test(proof.gitSha) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      proof.versionId,
    ) &&
    (legacyTag || attemptTag?.[1] === proof.gitSha) &&
    // Cloudflare emits microsecond precision (e.g. .29368Z); a strict
    // toISOString() roundtrip would reject every real timestamp. Require
    // full RFC 3339 datetime shape instead of date-only strings.
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(proof.deployedAt) &&
    Number.isFinite(deployedAt)
  );
}

function buildDeps(env: Env): WorkerDeps {
  return testDeps ?? nextDeps(env);
}

function pipelineOnly(deps: WorkerDeps): PipelineDeps {
  return {
    nextExecute: deps.nextExecute,
    keyVerifier: deps.keyVerifier,
    specSource: deps.specSource,
    fetchImpl: deps.fetchImpl,
    idGenerator: deps.idGenerator,
    now: deps.now,
  };
}

function discoveryDeps(deps: WorkerDeps, request: Request): DiscoveryDeps {
  return {
    catalogueSource: deps.catalogueSource,
    specSource: deps.publicSpecSource,
    gatewayOrigin: new URL(request.url).origin,
  };
}

function mockDeps(deps: WorkerDeps, env: Env): MockDeps {
  return {
    appOrigin: env.APP_ORIGIN,
    keyVerifier: deps.keyVerifier,
    specSource: deps.publicSpecSource,
    idGenerator: deps.idGenerator,
    now: deps.now,
  };
}

function mcpDeps(deps: WorkerDeps, env: Env, request: Request): McpDeps {
  return {
    catalogueSource: deps.catalogueSource,
    searchSource: deps.searchSource,
    specSource: deps.publicSpecSource,
    pipeline: pipelineOnly(deps),
    pipelineEnv: {
      APP_ORIGIN: env.APP_ORIGIN,
      GATEWAY_INTERNAL_SECRET: env.GATEWAY_INTERNAL_SECRET,
    },
    gatewayOrigin: new URL(request.url).origin,
  };
}

/**
 * Worker entry:
 * - /gateway/:publisherHandle/:projectSlug/* — metered proxy
 * - /mock/:publisherHandle/:projectSlug/* — public keyless example responses, 0 credits
 * - /discovery — machine-readable catalogue + pricing index
 * - /mcp — MCP Streamable HTTP (search / docs / metered call_api_read + call_api_write)
 * - /llms.txt — agent setup guide, same text as the web app's /llms.txt
 * - /connections — connected-account management + provider callback
 * - /internal/next-wake — authenticated wallet coordination
 * - /health
 */
async function dispatchRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // Public API: browsers preflight cross-origin calls with Authorization.
  if (request.method === "OPTIONS") {
    return corsPreflight();
  }
  if (url.pathname === "/internal/next-wake") return wakeWallet(request, env);
  if (url.pathname === "/internal/next-failure")
    return readWalletFailure(request, env);

  if (url.pathname === "/" || url.pathname === "/health") {
    const testMode = env.GATEWAY_TEST_MODE === "1";
    const deployment = gatewayDeploymentProof(env);
    const specConfigReady =
      testMode ||
      Boolean(
        env.NEXT_DEPLOYMENT_ID &&
        env.CONVEX_SITE_URL &&
        env.NEXT_SNAPSHOT_KEYS &&
        env.NEXT_ADMISSION_KEYS &&
        env.NEXT_TRANSPORT_KEYS &&
        env.EDGE_SNAPSHOTS &&
        env.NEXT_WALLET &&
        env.GATEWAY_INTERNAL_SECRET &&
        (env.ZEVIUM_RELEASE === undefined ||
          validGatewayDeploymentProof(deployment)),
      );
    return Response.json(
      {
        ok: specConfigReady,
        service: "zevium-gateway",
        release: env.ZEVIUM_RELEASE ?? "development",
        contract: 2,
        deployment,
      },
      { status: specConfigReady ? 200 : 503 },
    );
  }

  if (url.pathname === "/llms.txt") {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD, OPTIONS" },
      });
    // The guide links the web app throughout; refuse rather than guess it.
    const web = webOrigin(env.APP_ORIGIN);
    if (!web)
      return jsonError(
        503,
        "gateway_unavailable",
        "Gateway configuration is temporarily unavailable",
        crypto.randomUUID(),
      );
    const response = llmsResponse({ web, gateway: url.origin });
    // Public and origin-derived only; same freshness as /discovery.
    response.headers.set("cache-control", "public, max-age=60");
    return response;
  }

  // GET /discovery — public machine-readable index
  if (parts[0] === "discovery" && parts.length === 1) {
    const deps = buildDeps(env);
    return await handleDiscoveryRequest(request, discoveryDeps(deps, request));
  }

  if (parts[0] === "docs" && parts.length === 3) {
    return handleListingDocs(
      request,
      buildDeps(env).publicSpecSource,
      parts[1]!,
      parts[2]!,
    );
  }

  const oauth = oauthConfig(env.MCP_OAUTH_ISSUER, env.MCP_OAUTH_RESOURCE);
  if (
    oauth &&
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ].includes(url.pathname)
  ) {
    if (request.method !== "GET")
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, OPTIONS" },
      });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // The authoritative document (including DCR and S256 PKCE) belongs to Clerk.
      return Response.redirect(
        `${oauth.issuer}/.well-known/oauth-authorization-server`,
        307,
      );
    }
    return protectedResourceMetadata(oauth);
  }

  // /mcp — MCP Streamable HTTP
  if (parts[0] === "mcp" && parts.length === 1) {
    const deps = buildDeps(env);
    const mcp = mcpDeps(deps, env, request);
    if (oauth) {
      const apiKey = extractApiKey(request);
      const token = /^Bearer\s+(\S+)$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!apiKey && !token) return oauthChallenge(oauth);
      const verifier = deps.keyVerifier;
      const outcome = apiKey
        ? verifier.verifyWithStatus
          ? await verifier.verifyWithStatus(apiKey)
          : await verifier
              .verify(apiKey)
              .then((key) =>
                key
                  ? { status: "ok" as const, key }
                  : { status: "invalid" as const },
              )
        : await deps.oauthVerifier?.verify(token!);
      if (!outcome || outcome.status === "unavailable") {
        return Response.json(
          {
            error: "verification_unavailable",
            message: "Authentication is temporarily unavailable",
          },
          { status: 503 },
        );
      }
      if (
        outcome.status === "invalid" ||
        outcome.status === "insufficient_scope"
      )
        return oauthChallenge(
          oauth,
          outcome.status === "insufficient_scope"
            ? "insufficient_scope"
            : "invalid_token",
        );
      // OAuth identity is injected only here, never inferred inside the paid pipeline.
      if (outcome.status === "keyless")
        mcp.keylessOAuth = { keyState: outcome.keyState };
      else if (!apiKey) mcp.pipeline.authenticatedKey = outcome.key;
      // Stateless Streamable HTTP does not provide an SSE listener.
      if (request.method === "GET")
        return new Response(null, {
          status: 405,
          headers: { allow: "POST, OPTIONS" },
        });
    }
    return await handleMcpRequest(request, mcp, ctx);
  }

  const route = parseGatewayPath(url.pathname);
  if (route) {
    const deps = buildDeps(env);
    return await handleGatewayRequest(
      request,
      env,
      pipelineOnly(deps),
      ctx,
      route,
    );
  }

  if (parts[0] === "connections") {
    const response = await handleConnectionsRequest(
      request,
      testDeps?.connectionsDeps ?? nextConnectionsDeps(env),
    );
    if (response) return response;
  }

  const mockRoute = parseMockPath(url.pathname);
  if (mockRoute) {
    const deps = buildDeps(env);
    return await handleMockRequest(request, mockDeps(deps, env), mockRoute);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await dispatchRequest(request, env, ctx);
    } catch {
      response = Response.json({ error: "internal error" }, { status: 500 });
    }
    response = applyGatewaySecurityHeaders(request, response);
    if (!response.headers.has("x-zevium-request-id")) {
      response.headers.set("x-zevium-request-id", crypto.randomUUID());
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
