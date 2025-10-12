import { createFileRoute } from "@tanstack/react-router";

const PROXY_ROUTE_PREFIX = "/api/proxy";

// Placeholder: Replace with a real DB fetch for the proxy secret
async function getProxySecretFromDb(): Promise<string> {
  // TODO: Replace with real DB fetch
  return "replace-me-with-secret-from-db";
}

// Placeholder: Replace with a real DB lookup for host allowlist
async function isHostAllowlistedInDb(hostname: string): Promise<boolean> {
  // TODO: Replace with real DB lookup. For now, allow any non-private, non-local host.
  return !isPrivateOrLocalHostname(hostname);
}

function jsonWithRequestId(status: number, message: string, requestId: string) {
  return Response.json(
    { error: message },
    {
      headers: { "x-zevium-request-id": requestId },
      status,
    },
  );
}

function normalizeHostUrl(input: string): URL | null {
  try {
    const trimmed = input.trim();
    const withScheme = /^(https?:)?\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    return url;
  } catch {
    return null;
  }
}

function isIpv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function parseIpv4(host: string): number[] | null {
  if (!isIpv4(host)) return null;
  const parts = host.split(".").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return parts;
}

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "localhost." ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".localdomain") ||
    lower === "127.0.0.1" ||
    lower === "::1"
  ) {
    return true;
  }
  if (isPrivateIpv4(lower)) return true;
  // Conservative: block raw IPv6 literals via bracket or colon presence
  if (/[\[\]:]/.test(lower) && !isIpv4(lower)) return true;
  return false;
}

async function proxyHandler(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();

  const zeviumKey = request.headers.get("x-zevium-key");
  if (!zeviumKey) {
    return jsonWithRequestId(401, "Missing X-Zevium-Key", requestId);
  }

  const zeviumHostHeader = request.headers.get("x-zevium-host");
  if (!zeviumHostHeader) {
    return jsonWithRequestId(400, "Missing X-Zevium-Host", requestId);
  }

  // Verify API key with Better Auth
  try {
    const { authServer } = await import("~/lib/server/auth");
    const verification = await authServer.api.verifyApiKey({
      body: { key: zeviumKey, permissions: { api: ["read"] } },
    });
    if (!verification?.valid) {
      const errorMessage = verification?.error?.message ?? "Invalid API key";
      return jsonWithRequestId(401, errorMessage, requestId);
    }
  } catch (err) {
    return jsonWithRequestId(500, "Failed to verify API key", requestId);
  }

  // Normalize and validate host
  const normalized = normalizeHostUrl(zeviumHostHeader);
  if (!normalized) {
    return jsonWithRequestId(400, "Invalid X-Zevium-Host", requestId);
  }
  if (normalized.protocol !== "https:") {
    return jsonWithRequestId(400, "Only HTTPS hosts are allowed", requestId);
  }
  if (isPrivateOrLocalHostname(normalized.hostname)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  // Allowlist check (placeholder)
  const isAllowlisted = await isHostAllowlistedInDb(normalized.hostname);
  if (!isAllowlisted) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  // Build target URL by rewriting the incoming URL
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(originalUrl);
  targetUrl.protocol = "https";
  targetUrl.hostname = normalized.hostname;
  targetUrl.port = normalized.port || "443";
  targetUrl.pathname = targetUrl.pathname.replace(/^\/*api\/*proxy/i, "");

  // Prepare outbound headers
  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("x-zevium-key");
  outboundHeaders.delete("content-length");
  outboundHeaders.delete("cookie");
  outboundHeaders.set("host", normalized.hostname);
  outboundHeaders.set("x-zevium-request-id", requestId);
  outboundHeaders.set("x-zevium-host", normalized.hostname);
  const proxySecret = await getProxySecretFromDb();
  if (proxySecret) outboundHeaders.set("x-zevium-proxy-secret", proxySecret);

  try {
    const upstream = await fetch(targetUrl, {
      body: request.body,
      // @ts-expect-error duplex is not in the type definition (Node.js fetch streaming)
      duplex: "half",
      headers: outboundHeaders,
      method: request.method,
    });

    const responseHeaders = new Headers(upstream.headers);
    // Ensure request id is included in the client response
    responseHeaders.set("x-zevium-request-id", requestId);
    // Never leak the proxy secret back to the client
    responseHeaders.delete("x-zevium-proxy-secret");

    return new Response(upstream.body, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    return jsonWithRequestId(502, "Upstream request failed", requestId);
  }
}

export const Route = createFileRoute("/api/proxy/$")({
  server: {
    handlers: {
      DELETE: ({ request }) => proxyHandler(request),
      GET: ({ request }) => proxyHandler(request),
      HEAD: ({ request }) => proxyHandler(request),
      OPTIONS: ({ request }) => proxyHandler(request),
      PATCH: ({ request }) => proxyHandler(request),
      POST: ({ request }) => proxyHandler(request),
      PUT: ({ request }) => proxyHandler(request),
    },
  },
});


