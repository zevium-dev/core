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
  "/logo.svg",
  "/manifest.json",
  "/robots.txt",
  "/zevium-wordmark.svg",
]);

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
  return pathname.startsWith("/assets/") || PUBLIC_ASSET_PATHS.has(pathname);
}

const fetch: RequestHandler<Register> = async (request, options) => {
  const nonce = createCspNonce();
  let response: Response;
  try {
    const assets = readAssetFetcher(options);
    if (assets !== null && isStaticAsset(new URL(request.url).pathname)) {
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
