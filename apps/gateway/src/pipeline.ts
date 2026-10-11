import type { KeyVerifier, VerifiedKey } from "./key-verifier";
import type { SpecSource } from "./spec-source";

export type PipelineEnv = {
  /** Paired web application origin for payment recovery actions. */
  APP_ORIGIN?: string;
  ZEVIUM_RELEASE?: string;
  GATEWAY_INTERNAL_SECRET?: string;
};

export type PipelineDeps = {
  nextExecute?: (
    request: Request,
    env: PipelineEnv,
    ctx: ExecutionContext,
    route: GatewayRoute,
    prepare?: (response: Response) => Promise<Response>,
    authenticatedKey?: VerifiedKey,
  ) => Promise<Response>;
  keyVerifier: KeyVerifier;
  /** Trusted MCP OAuth identity; never populated from request parameters. */
  authenticatedKey?: VerifiedKey;
  specSource: SpecSource;
  /** Upstream fetch — inject mock in tests. */
  fetchImpl?: typeof fetch;
  /** Id generator for request/reservation ids. */
  idGenerator?: () => string;
  now?: () => number;
};

export type GatewayRoute = {
  publisherHandle: string;
  projectSlug: string;
  /** Remainder path under /gateway/:org/:project */
  remainderPath: string;
};

export function parseGatewayPath(pathname: string): GatewayRoute | null {
  // /gateway/:publisherHandle/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "gateway") return null;
  if (!parts[1] || !parts[2]) return null;
  const publisherHandle = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { publisherHandle, projectSlug, remainderPath };
}

/** Shared metered call path for HTTP and MCP. Each stage receives explicit state. */
export async function handleGatewayRequest(
  request: Request,
  env: PipelineEnv,
  deps: PipelineDeps,
  _ctx: ExecutionContext,
  route: GatewayRoute,
  /** Buffered adapters prepare their result before settlement; rejection refunds. */
  prepareResponse?: (response: Response) => Promise<Response>,
): Promise<Response> {
  if (deps.nextExecute)
    return deps.nextExecute(
      request,
      env,
      _ctx,
      route,
      prepareResponse,
      deps.authenticatedKey,
    );
  return Response.json({ error: "gateway_unavailable" }, { status: 503 });
}
