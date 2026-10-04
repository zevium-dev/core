import { resolveGatewayOrigin } from "./landing";

const STRIP_HEADERS = [
  "x-clerk-auth-message",
  "x-clerk-auth-reason",
  "x-clerk-auth-status",
  "x-powered-by",
] as const;

function sourceOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Clerk encodes its Frontend API hostname in the public instance key. */
function clerkFrontendOrigin(
  publishableKey: string | undefined,
): string | null {
  const encoded = publishableKey?.match(
    /^pk_(?:live|test)_([A-Za-z0-9+/=]+)$/,
  )?.[1];
  if (!encoded) return null;
  try {
    const decoded = atob(encoded);
    if (!decoded.endsWith("$")) return null;
    const hostname = decoded.slice(0, -1);
    // Only a hostname may become a CSP source, never URL syntax or directives.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname)) {
      return null;
    }
    return `https://${hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function buildWebContentSecurityPolicy(
  nonce: string,
  options: { upgradeInsecureRequests?: boolean } = {},
): string {
  const convex = sourceOrigin(import.meta.env.VITE_CONVEX_URL);
  const gateway = sourceOrigin(
    resolveGatewayOrigin(import.meta.env.VITE_GATEWAY_URL),
  );
  const clerk = clerkFrontendOrigin(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
  const websocket = convex === null ? null : convex.replace(/^https:/, "wss:");
  const connectSources = [
    "'self'",
    convex,
    websocket,
    gateway,
    clerk,
    "https://api.clerk.com",
    "https://*.clerk.accounts.dev",
    "https://clerk-telemetry.com",
    "https://*.protect.clerk.com:*",
  ].filter((source): source is string => source !== null);
  const clerkSources = ["https://*.clerk.accounts.dev", clerk]
    .filter((source): source is string => source !== null)
    .join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://api.clerk.com ${clerkSources} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://img.clerk.com https://images.clerk.dev",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self' blob:",
    `frame-src ${clerkSources} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${clerkSources}`,
    "frame-ancestors 'none'",
    ...(options.upgradeInsecureRequests === false
      ? []
      : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function isDeployedHttps(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.protocol === "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  );
}

/** Dynamic outer boundary. Response body remains streamed and unbuffered. */
export function applyWebSecurityHeaders(
  request: Request,
  response: Response,
  nonce: string,
): Response {
  const headers = new Headers(response.headers);
  for (const name of STRIP_HEADERS) headers.delete(name);
  const deployedHttps = isDeployedHttps(request);
  headers.set(
    "Content-Security-Policy",
    buildWebContentSecurityPolicy(nonce, {
      upgradeInsecureRequests: deployedHttps,
    }),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  // OAuth popup flows require opener access; COEP intentionally omitted.
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (deployedHttps) {
    // No includeSubDomains/preload: apex and sibling ownership is not proven.
    headers.set("Strict-Transport-Security", "max-age=31536000");
  } else {
    headers.delete("Strict-Transport-Security");
  }
  const path = new URL(request.url).pathname;
  if (
    response.status >= 300 ||
    path.startsWith("/_serverFn/") ||
    path.startsWith("/app") ||
    path.startsWith("/admin") ||
    path.startsWith("/sign-in") ||
    path.startsWith("/sign-up") ||
    response.headers.get("content-type")?.includes("text/html") === true
  ) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}
