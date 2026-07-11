import { WalletDO } from "./wallet";
import { ClerkKeyVerifier, FixtureKeyVerifier } from "./key-verifier";
import {
  CachedSpecSource,
  ConvexSpecSource,
  FixtureSpecSource,
} from "./spec-source";
import { ConsoleUsageSink } from "./usage";
import {
  handleGatewayRequest,
  parseGatewayPath,
  type PipelineDeps,
} from "./pipeline";

export { WalletDO };

export interface Env {
  WALLET: DurableObjectNamespace<WalletDO>;
  CLERK_SECRET_KEY?: string;
  CONVEX_URL?: string;
  /**
   * Test-only: when set, Worker uses fixture key/spec sources populated via
   * internal test helpers (see test/pipeline.test.ts). Not for production.
   */
  GATEWAY_TEST_MODE?: string;
}

// Test-mode singletons (module scope per isolate). Production never sets GATEWAY_TEST_MODE.
let testDeps: PipelineDeps | null = null;

/** Test harness installs fixture deps before calling fetch. */
export function __setTestPipelineDeps(deps: PipelineDeps | null): void {
  testDeps = deps;
}

export function __getTestPipelineDeps(): PipelineDeps | null {
  return testDeps;
}

function buildDeps(env: Env): PipelineDeps {
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

  return {
    keyVerifier,
    specSource: new CachedSpecSource({ inner: innerSpec }),
    usageSink: new ConsoleUsageSink(),
  };
}

/**
 * Worker entry:
 * - /gateway/:orgSlug/:projectSlug/* — metered proxy
 * - /wallet/:orgId/* — wallet DO HTTP surface (grants/tests)
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

    // /wallet/:orgId[/*] — DO grant/reserve surface for ops + tests
    if (parts[0] === "wallet" && parts[1]) {
      const orgId = parts[1];
      const rest = "/" + parts.slice(2).join("/");
      const id = env.WALLET.idFromName(orgId);
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

    const route = parseGatewayPath(url.pathname);
    if (route) {
      const deps = buildDeps(env);
      return handleGatewayRequest(request, env, deps, ctx, route);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
