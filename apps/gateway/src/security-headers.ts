const STRIP_HEADERS = [
  "x-clerk-auth-message",
  "x-clerk-auth-reason",
  "x-clerk-auth-status",
  "x-powered-by",
] as const;

export const GATEWAY_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

function isDeployedHttps(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.protocol === "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  );
}

/** Outermost policy for every gateway route, error, preflight, and stream. */
export function applyGatewaySecurityHeaders(
  request: Request,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  for (const name of STRIP_HEADERS) headers.delete(name);
  headers.set("Content-Security-Policy", GATEWAY_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  // API and mock payloads are intentionally readable cross-origin via CORS.
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  if (isDeployedHttps(request)) {
    // No includeSubDomains/preload: apex and every sibling are not owned here.
    headers.set("Strict-Transport-Security", "max-age=31536000");
  } else {
    headers.delete("Strict-Transport-Security");
  }
  if (
    response.status >= 400 ||
    new URL(request.url).pathname.startsWith("/internal/")
  ) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
