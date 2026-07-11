import { WalletDO } from "./wallet";
import { ClerkKeyVerifier, FixtureKeyVerifier } from "./key-verifier";
import {
  CachedSpecSource,
  ConvexSpecSource,
  FixtureSpecSource,
} from "./spec-source";
import {
  CachedCatalogueSource,
  ConvexCatalogueSource,
  FixtureCatalogueSource,
  type CatalogueSource,
} from "./catalogue-source";
import { ConsoleUsageSink, ConvexUsageSink, NoopUsageSink } from "./usage";
import {
  handleGatewayRequest,
  parseGatewayPath,
  type PipelineDeps,
} from "./pipeline";
import { handleDiscoveryRequest, type DiscoveryDeps } from "./discovery";
import { handleMcpRequest, type McpDeps } from "./mcp";

export { WalletDO };
export { __setTestUsageMutation, __setTestGrantsFetcher } from "./wallet";

export interface Env {
  WALLET: DurableObjectNamespace<WalletDO>;
  CLERK_SECRET_KEY?: string;
  CONVEX_URL?: string;
  /** Convex .convex.site origin for httpActions (ingest-usage). */
  CONVEX_SITE_URL?: string;
  /** Deploy/admin key fallback for internalMutation wallets:recordUsage. */
  CONVEX_DEPLOY_KEY?: string;
  /** Shared secret for POST /internal/grant + Convex /ingest-usage. */
  GATEWAY_INTERNAL_SECRET?: string;
  /**
   * Test-only: when set, Worker uses fixture key/spec sources populated via
   * internal test helpers (see test/pipeline.test.ts). Not for production.
   */
  GATEWAY_TEST_MODE?: string;
}

/** Full worker deps: pipeline + catalogue for discovery/MCP. */
export type WorkerDeps = PipelineDeps & {
  catalogueSource: CatalogueSource;
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

function buildDeps(env: Env): WorkerDeps {
  // Module-scoped test harness wins when installed (vitest-pool-workers).
  if (testDeps) {
    return testDeps;
  }

  const keyVerifier = env.CLERK_SECRET_KEY
    ? new ClerkKeyVerifier({ secretKey: env.CLERK_SECRET_KEY })
    : new FixtureKeyVerifier();

  const innerSpec = env.CONVEX_URL
    ? new ConvexSpecSource({ convexUrl: env.CONVEX_URL })
    : new FixtureSpecSource();

  const innerCatalogue = env.CONVEX_URL
    ? new ConvexCatalogueSource({ convexUrl: env.CONVEX_URL })
    : new FixtureCatalogueSource();

  const usageSink = env.CONVEX_URL
    ? // Pipeline emit is best-effort logging; authoritative flush is DO alarm.
      new ConsoleUsageSink()
    : new NoopUsageSink();

  // Keep ConvexUsageSink constructable for tests / future dual-write.
  void ConvexUsageSink;

  return {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),
    catalogueSource: new CachedCatalogueSource({
      inner: innerCatalogue,
      ttlMs: 60_000,
    }),
    usageSink,
  };
}

function pipelineOnly(deps: WorkerDeps): PipelineDeps {
  return {
    keyVerifier: deps.keyVerifier,
    specSource: deps.specSource,
    usageSink: deps.usageSink,
    fetchImpl: deps.fetchImpl,
    idGenerator: deps.idGenerator,
    now: deps.now,
  };
}

function discoveryDeps(deps: WorkerDeps, request: Request): DiscoveryDeps {
  return {
    catalogueSource: deps.catalogueSource,
    specSource: deps.specSource,
    gatewayOrigin: new URL(request.url).origin,
  };
}

function mcpDeps(deps: WorkerDeps, env: Env, request: Request): McpDeps {
  return {
    catalogueSource: deps.catalogueSource,
    specSource: deps.specSource,
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
 * - /gateway/:orgSlug/:projectSlug/* — metered proxy
 * - /discovery — machine-readable catalogue + pricing index
 * - /mcp — MCP Streamable HTTP (search / docs / metered call_api)
 * - /wallet/:clerkOrgId/* — wallet DO HTTP surface (grants/tests)
 * - /internal/grant — control-plane grant push (shared secret)
 * - /health
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "zevium-gateway" });
    }

    // POST /internal/grant { clerkOrgId, amount, refId }
    if (parts[0] === "internal" && parts[1] === "grant") {
      return handleInternalGrant(request, env);
    }

    // /wallet/:clerkOrgId[/*] — DO grant/reserve surface for ops + tests
    if (parts[0] === "wallet" && parts[1]) {
      const clerkOrgId = parts[1];
      const rest = "/" + parts.slice(2).join("/");
      const id = env.WALLET.idFromName(clerkOrgId);
      const stub = env.WALLET.get(id);

      const doUrl = new URL(rest === "/" ? "/state" : rest, url.origin);
      doUrl.search = url.search;

      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.arrayBuffer();
      }

      return stub.fetch(new Request(doUrl.toString(), init));
    }

    // GET /discovery — public machine-readable index
    if (parts[0] === "discovery" && parts.length === 1) {
      const deps = buildDeps(env);
      return handleDiscoveryRequest(request, discoveryDeps(deps, request));
    }

    // /mcp — MCP Streamable HTTP
    if (parts[0] === "mcp" && parts.length === 1) {
      const deps = buildDeps(env);
      return handleMcpRequest(request, mcpDeps(deps, env, request), ctx);
    }

    const route = parseGatewayPath(url.pathname);
    if (route) {
      const deps = buildDeps(env);
      return handleGatewayRequest(request, env, pipelineOnly(deps), ctx, route);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

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
