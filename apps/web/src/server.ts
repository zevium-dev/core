import {
  createStartHandler,
  defaultStreamHandler,
  type RequestHandler,
} from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import type { Register } from "@tanstack/react-router";

import {
  applyWebSecurityHeaders,
  createCspNonce,
} from "#/lib/security-headers";

const startHandler = createStartHandler(defaultStreamHandler);

const PUBLIC_ASSET_PATHS = new Set([
  "/favicon.ico",
  "/logo192.png",
  "/logo512.png",
  "/logo.svg",
  "/manifest.json",
  "/robots.txt",
  "/zevium-wordmark.svg",
]);

/** Public release facts for the payment proof runner; never serialize bindings. */
function deploymentProofResponse(request: Request, options: unknown): Response {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { ...headers, Allow: "GET, HEAD" } },
    );
  }

  const metadata =
    typeof options === "object" && options !== null
      ? (options as { CF_VERSION_METADATA?: unknown }).CF_VERSION_METADATA
      : undefined;
  const { id, tag, timestamp } =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)
      : {};
  const gitSha = import.meta.env.VITE_BUILD_SHA;
  const release =
    typeof tag === "string"
      ? /^(staging|production|preview-[1-9][0-9]*)-([0-9a-f]{40})(?:-[1-9][0-9]*-[1-9][0-9]*)?$/.exec(
          tag,
        )
      : null;
  const available =
    release !== null &&
    release[2] === gitSha &&
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    ) &&
    typeof timestamp === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(timestamp) &&
    Number.isFinite(Date.parse(timestamp));
  const response = available
    ? Response.json(
        {
          schemaVersion: 1,
          service: "web",
          mode: release[1].startsWith("preview-") ? "preview" : release[1],
          gitSha,
          deploymentId: id,
          deployedAt: new Date(timestamp).toISOString(),
        },
        { headers },
      )
    : Response.json(
        { error: "Deployment metadata unavailable" },
        { status: 503, headers },
      );
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

type AssetFetcher = {
  fetch(request: Request): Promise<Response>;
};

function readAssetFetcher(options: unknown): AssetFetcher | null {
  if (typeof options !== "object" || options === null) return null;
  const candidate = (options as { ASSETS?: unknown }).ASSETS;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { fetch?: unknown }).fetch !== "function"
  ) {
    return null;
  }
  return candidate as AssetFetcher;
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/assets/") ||
    PUBLIC_ASSET_PATHS.has(pathname) ||
    // Worker-first routing also intercepts Vite's unbundled client modules,
    // styles and HMR entry points. Let the asset binding reach Vite in dev.
    (import.meta.env.DEV &&
      (pathname.startsWith("/src/") ||
        pathname.startsWith("/@") ||
        pathname.startsWith("/node_modules/")))
  );
}

const fetch: RequestHandler<Register> = async (request, options) => {
  const nonce = createCspNonce();
  let response: Response;
  try {
    const assets = readAssetFetcher(options);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/.well-known/zevium-deployment.json") {
      response = deploymentProofResponse(request, options);
    } else if (assets !== null && isStaticAsset(pathname)) {
      response = await assets.fetch(request);
    } else {
      response = await startHandler(request, {
        ...options,
        context: { ...options?.context, nonce },
      });
    }
  } catch {
    response = new Response("Internal Server Error", { status: 500 });
  }
  return applyWebSecurityHeaders(request, response, nonce);
};

export default createServerEntry({ fetch });
