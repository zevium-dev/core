import { WalletDO } from "./wallet";
import { ClerkKeyVerifier, FixtureKeyVerifier } from "./key-verifier";
import {
  CachedPublicSpecSource,
  CachedSpecSource,
  ConvexPublicSpecSource,
  FailClosedPublicSpecSource,
  FailClosedSpecSource,
  FixtureSpecSource,
  InternalHttpSpecSource,
  type PublicSpecSource,
} from "./spec-source";
import {
  CachedCatalogueSource,
  ConvexCatalogueSource,
  FailClosedCatalogueSource,
  FixtureCatalogueSource,
  type CatalogueSource,
} from "./catalogue-source";
import { ConvexUsageSink, NoopUsageSink } from "./usage";
import {
  handleGatewayRequest,
  parseGatewayPath,
  type PipelineDeps,
} from "./pipeline";
import { handleDiscoveryRequest, type DiscoveryDeps } from "./discovery";
import { handleMcpRequest, type McpDeps } from "./mcp";
import { corsPreflight, withCors } from "./cors";
import { handleMockRequest, parseMockPath, type MockDeps } from "./mock";

import { ControlDO, verifyControlRequest } from "./control";
import { applyGatewaySecurityHeaders } from "./security-headers";

export { WalletDO, ControlDO };
export { __setTestUsageMutation, __setTestGrantsFetcher } from "./wallet";

export interface Env {
  WALLET: DurableObjectNamespace<WalletDO>;
  CONTROL?: DurableObjectNamespace<ControlDO>;
  CLERK_SECRET_KEY?: string;
  CONVEX_URL?: string;
  /** Convex .convex.site origin for httpActions (ingest-usage). */
  CONVEX_SITE_URL?: string;
  /** Deploy/admin key fallback for internalMutation wallets:recordUsage. */
  CONVEX_DEPLOY_KEY?: string;
  /** Shared secret for POST /internal/grant + Convex /ingest-usage. */
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
  /** Credential-free source for discovery, docs, and keyless mocks. */
  publicSpecSource: PublicSpecSource;
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
  return (
    /^[0-9a-f]{40}$/.test(proof.gitSha) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      proof.versionId,
    ) &&
    /^(?:preview-[1-9][0-9]*-[0-9a-f]{40}|(?:staging|production)-[0-9a-f]{40})$/.test(
      proof.versionTag,
    ) &&
    proof.versionTag.endsWith(proof.gitSha) &&
    // Cloudflare emits microsecond precision (e.g. .29368Z); a strict
    // toISOString() roundtrip would reject every real timestamp. Require
    // full RFC 3339 datetime shape instead of date-only strings.
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(proof.deployedAt) &&
    Number.isFinite(deployedAt)
  );
}

// Module-scoped prod deps, lazily built on first request and reused across
// requests in the same isolate. CachedSpecSource / CachedCatalogueSource /
// ClerkKeyVerifier all carry TTL/in-memory caches; rebuilding per request
// defeats them. Keyed on an env fingerprint so config changes (deploy, env
// swap, tests) invalidate the cache instead of serving stale clients.
let cachedProdDeps: { fingerprint: string; deps: WorkerDeps } | null = null;
/** Test-only: clear the module-scoped prod dep cache (e.g. between env swaps). */
export function __resetProdDepsCache(): void {
  cachedProdDeps = null;
}

function buildDeps(env: Env): WorkerDeps {
  // Module-scoped test harness wins when installed (vitest-pool-workers).
  if (testDeps) {
    return testDeps;
  }

  // NUL-joined to avoid ambiguity when one field is empty.
  const fingerprint = [
    env.CLERK_SECRET_KEY ?? "",
    env.CONVEX_URL ?? "",
    env.CONVEX_SITE_URL ?? "",
    env.GATEWAY_INTERNAL_SECRET ?? "",
  ].join("\u0000");
  if (cachedProdDeps && cachedProdDeps.fingerprint === fingerprint) {
    return cachedProdDeps.deps;
  }

  const testMode = env.GATEWAY_TEST_MODE === "1";
  const keyVerifier = env.CLERK_SECRET_KEY
    ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
    : testMode
      ? new FixtureKeyVerifier()
      : { verify: async () => null };

  const siteUrl =
    env.CONVEX_SITE_URL ??
    env.CONVEX_URL?.replace(".convex.cloud", ".convex.site");
  const innerSpec =
    siteUrl && env.GATEWAY_INTERNAL_SECRET
      ? new InternalHttpSpecSource({
          siteUrl,
          internalSecret: env.GATEWAY_INTERNAL_SECRET,
        })
      : env.CONVEX_URL
        ? new FailClosedSpecSource()
        : testMode
          ? new FixtureSpecSource()
          : new FailClosedSpecSource();
  const innerPublicSpec = env.CONVEX_URL
    ? new ConvexPublicSpecSource({ convexUrl: env.CONVEX_URL })
    : testMode
      ? new FixtureSpecSource()
      : new FailClosedPublicSpecSource();

  const innerCatalogue = env.CONVEX_URL
    ? new ConvexCatalogueSource({ convexUrl: env.CONVEX_URL })
    : testMode
      ? new FixtureCatalogueSource()
      : new FailClosedCatalogueSource();

  // Durable call evidence rides the Wallet DO settlement outbox. This sink is
  // observability/test-only and must never become a second Convex write path.
  const usageSink = new NoopUsageSink();

  // Keep ConvexUsageSink constructable for tests / future dual-write.
  void ConvexUsageSink;

  const deps: WorkerDeps = {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),
    publicSpecSource: new CachedPublicSpecSource({ inner: innerPublicSpec }),
    catalogueSource: new CachedCatalogueSource({
      inner: innerCatalogue,
      ttlMs: 60_000,
    }),
    usageSink,
    routeAllowed: env.CONTROL
      ? async (publisherHandle, projectSlug) => {
          const stub = env.CONTROL!.get(env.CONTROL!.idFromName("global"));
          const response = await stub.fetch(
            `https://control.invalid/gate?route=${encodeURIComponent(`${publisherHandle}/${projectSlug}`)}`,
          );
          if (!response.ok) return false;
          const gate = (await response.json()) as { allowed?: boolean } | null;
          return gate?.allowed !== false;
        }
      : undefined,
  };
  cachedProdDeps = { fingerprint, deps };
  return deps;
}

function pipelineOnly(deps: WorkerDeps): PipelineDeps {
  return {
    keyVerifier: deps.keyVerifier,
    specSource: deps.specSource,
    usageSink: deps.usageSink,
    fetchImpl: deps.fetchImpl,
    idGenerator: deps.idGenerator,
    now: deps.now,
    routeAllowed: deps.routeAllowed,
  };
}

function discoveryDeps(deps: WorkerDeps, request: Request): DiscoveryDeps {
  return {
    catalogueSource: deps.catalogueSource,
    specSource: deps.publicSpecSource,
    gatewayOrigin: new URL(request.url).origin,
  };
}

function mockDeps(deps: WorkerDeps): MockDeps {
  return {
    keyVerifier: deps.keyVerifier,
    specSource: deps.publicSpecSource,
    idGenerator: deps.idGenerator,
    now: deps.now,
  };
}

function mcpDeps(deps: WorkerDeps, env: Env, request: Request): McpDeps {
  return {
    catalogueSource: deps.catalogueSource,
    specSource: deps.publicSpecSource,
    pipeline: pipelineOnly(deps),
    pipelineEnv: { WALLET: env.WALLET },
    gatewayOrigin: new URL(request.url).origin,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

/**
 * Worker entry:
 * - /gateway/:publisherHandle/:projectSlug/* — metered proxy
 * - /mock/:publisherHandle/:projectSlug/* — public keyless example responses, 0 credits
 * - /discovery — machine-readable catalogue + pricing index
 * - /mcp — MCP Streamable HTTP (search / docs / metered call_api)
 * - /internal/grant — control-plane grant projection (shared secret)
 * - /internal/sync — control-plane checkpoint refresh (shared secret)
 * - /internal/key-revocation — monotonic signed key revoke (shared secret HMAC)
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

  if (url.pathname === "/" || url.pathname === "/health") {
    const testMode = env.GATEWAY_TEST_MODE === "1";
    const deployment = gatewayDeploymentProof(env);
    const specConfigReady =
      testMode ||
      Boolean(
        env.CONVEX_URL &&
        env.CONVEX_SITE_URL &&
        env.GATEWAY_INTERNAL_SECRET &&
        env.CLERK_SECRET_KEY &&
        validGatewayDeploymentProof(deployment),
      );
    return withCors(
      Response.json(
        {
          ok: specConfigReady,
          service: "zevium-gateway",
          release: env.ZEVIUM_RELEASE ?? "development",
          contract: 1,
          deployment,
        },
        { status: specConfigReady ? 200 : 503 },
      ),
    );
  }

  if (
    request.method === "POST" &&
    url.pathname.startsWith("/internal/registry/v1/")
  ) {
    return handleGatewayControl(request, env);
  }

  // POST /internal/grant { clerkOrgId, amount, refId }
  if (parts[0] === "internal" && parts[1] === "grant" && parts.length === 2) {
    return handleInternalGrant(request, env);
  }

  // POST /internal/sync { clerkOrgId }
  if (parts[0] === "internal" && parts[1] === "sync" && parts.length === 2) {
    return handleInternalSync(request, env);
  }

  // GET /discovery — public machine-readable index
  if (parts[0] === "discovery" && parts.length === 1) {
    const deps = buildDeps(env);
    return withCors(
      await handleDiscoveryRequest(request, discoveryDeps(deps, request)),
    );
  }

  // /mcp — MCP Streamable HTTP
  if (parts[0] === "mcp" && parts.length === 1) {
    const deps = buildDeps(env);
    return withCors(
      await handleMcpRequest(request, mcpDeps(deps, env, request), ctx),
    );
  }

  const route = parseGatewayPath(url.pathname);
  if (route) {
    const deps = buildDeps(env);
    return withCors(
      await handleGatewayRequest(request, env, pipelineOnly(deps), ctx, route),
    );
  }

  const mockRoute = parseMockPath(url.pathname);
  if (mockRoute) {
    const deps = buildDeps(env);
    return withCors(
      await handleMockRequest(request, mockDeps(deps), mockRoute),
    );
  }

  return withCors(Response.json({ error: "not found" }, { status: 404 }));
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
      response = withCors(
        Response.json({ error: "internal error" }, { status: 500 }),
      );
    }
    return applyGatewaySecurityHeaders(request, response);
  },
} satisfies ExportedHandler<Env>;

async function handleGatewayControl(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GATEWAY_INTERNAL_SECRET || !env.CONTROL) {
    return Response.json({ error: "misconfigured" }, { status: 503 });
  }
  const verified = await verifyControlRequest(
    request,
    env.GATEWAY_INTERNAL_SECRET,
  );
  if (verified === null) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const stub = env.CONTROL.get(env.CONTROL.idFromName("global"));
  const applied = await stub.fetch("https://control.invalid/apply", {
    method: "POST",
    body: verified.body,
  });
  if (!applied.ok) return applied;
  const result = (await applied.json()) as { status: string };
  const deps = buildDeps(env);
  deps.specSource.invalidate?.(
    verified.payload.publisherHandle,
    verified.payload.projectSlug,
  );
  deps.publicSpecSource.invalidate?.(
    verified.payload.publisherHandle,
    verified.payload.projectSlug,
  );
  deps.catalogueSource.invalidate?.();
  return Response.json({
    status: result.status,
    sourceRevision: verified.payload.sourceRevision,
    operation: verified.payload.operation,
  });
}

async function handleInternalGrant(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const secret = env.GATEWAY_INTERNAL_SECRET;
  if (!secret) {
    return Response.json(
      { error: "misconfigured", message: "GATEWAY_INTERNAL_SECRET not set" },
      { status: 500 },
    );
  }

  const provided =
    request.headers.get("x-gateway-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!provided || !timingSafeEqual(provided, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const clerkOrgId =
    "clerkOrgId" in body && typeof body.clerkOrgId === "string"
      ? body.clerkOrgId
      : "";
  const amount =
    "amount" in body && typeof body.amount === "number" ? body.amount : NaN;
  const refId =
    "refId" in body && typeof body.refId === "string" ? body.refId : "";

  if (!clerkOrgId || !refId || !(amount > 0) || !Number.isFinite(amount)) {
    return Response.json(
      {
        error: "invalid_body",
        message: "clerkOrgId, amount (>0), refId required",
      },
      { status: 400 },
    );
  }

  const id = env.WALLET.idFromName(clerkOrgId);
  const stub = env.WALLET.get(id);
  const result = await stub.grant(refId, amount);
  return Response.json(result);
}

async function handleInternalSync(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const secret = env.GATEWAY_INTERNAL_SECRET;
  if (!secret) {
    return Response.json(
      { error: "misconfigured", message: "GATEWAY_INTERNAL_SECRET not set" },
      { status: 500 },
    );
  }

  const provided =
    request.headers.get("x-gateway-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!provided || !timingSafeEqual(provided, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const clerkOrgId =
    "clerkOrgId" in body && typeof body.clerkOrgId === "string"
      ? body.clerkOrgId
      : "";
  if (!clerkOrgId) {
    return Response.json(
      { error: "invalid_body", message: "clerkOrgId required" },
      { status: 400 },
    );
  }

  const id = env.WALLET.idFromName(clerkOrgId);
  return Response.json(await env.WALLET.get(id).syncGrants(clerkOrgId));
}
