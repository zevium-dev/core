import type { WalletDO } from "./wallet";
import type { KeyVerifier } from "./key-verifier";
import type { SpecSource } from "./spec-source";
import { admit } from "./admit";
import { forward } from "./forward";
import { finalize } from "./finalize";

export type PipelineEnv = {
  WALLET: DurableObjectNamespace<WalletDO>;
  ZEVIUM_RELEASE?: string;
};

export type PipelineDeps = {
  keyVerifier: KeyVerifier;
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
  const started = (deps.now ?? Date.now)();
  const requestId = deps.idGenerator?.() ?? crypto.randomUUID();
  const admission = await admit(request, env, deps, route, requestId, started);
  if (admission instanceof Response) return admission;
  return finalize(
    admission,
    await forward(request, admission, deps.fetchImpl, prepareResponse),
    deps.now,
  );
}
