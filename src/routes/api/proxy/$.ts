import { createFileRoute } from "@tanstack/react-router";
import { lookup } from "node:dns/promises";
import isPrivate from "private-ip";

class UpstreamNonOK extends Error {
  response: Response;
  constructor(response: Response) {
    super("Upstream response not OK");
    this.response = response;
  }
}

// Placeholder: Replace with a real DB fetch for the proxy secret
async function getProxySecretFromDb(): Promise<string> {
  // TODO: Replace with real DB fetch
  return await Promise.resolve("replace-me-with-secret-from-db");
}

// Placeholder: Replace with a real DB lookup for host allowlist
async function isHostAllowlistedInDb(_hostname: string): Promise<boolean> {
  // TODO: Replace with real DB lookup
  return await Promise.resolve(true);
}

// Robust local/private host detection using DNS resolution and IP checks
async function isLocalOrPrivateHost(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "::1") return true;
  try {
    //I think this is slowlying down the proxy . TODO: Find a way to cache this.
    const results = await lookup(hostname, { all: true, verbatim: true });
    for (const { address } of results) {
      if (isPrivate(address) || isLoopback(address)) return true;
    }
    return false;
  } catch (_error) {
    // Fail closed: treat as local/private on resolution error
    return true;
  }
}

function isLoopback(addr: string): boolean {
  return (
    /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/.test(addr) ||
    addr.startsWith("0177.") ||
    /^0x7f\./i.test(addr) ||
    /^fe80::1$/i.test(addr) ||
    /^::1$/.test(addr) ||
    /^::$/.test(addr)
  );
}

// (Previous hostname-only private/local checks removed in favor of robust DNS/IP validation.)

function jsonWithRequestId(status: number, message: string, requestId: string) {
  return Response.json(
    { error: message },
    {
      headers: { "x-zevium-request-id": requestId },
      status,
    },
  );
}

function normalizeHostUrl(input: string): null | URL {
  try {
    const trimmed = input.trim();
    const withScheme = /^(https?:)?\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    return url;
  } catch {
    return null;
  }
}

const proxyHandler = async (request: Request) => {
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

  const { authServer } = await import("~/lib/server/auth");
  const verification = await authServer.api.verifyApiKey({
    body: { key: zeviumKey, permissions: { api: ["read"] } },
  });

  if (!verification.valid) {
    return jsonWithRequestId(401, "Failed to verify API key", requestId);
  }

  if (verification.error) {
    const errorMessage = verification.error.message ?? "Failed to verify API key";
    return jsonWithRequestId(500, errorMessage, requestId);
  }

  // Normalize and validate host
  const normalized = normalizeHostUrl(zeviumHostHeader);
  if (!normalized) {
    return jsonWithRequestId(400, "Invalid X-Zevium-Host", requestId);
  }
  if (normalized.protocol !== "https:") {
    return jsonWithRequestId(400, "Only HTTPS hosts are allowed", requestId);
  }
  // Additional robust DNS/IP-based private/local check
  if (await isLocalOrPrivateHost(normalized.hostname)) {
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
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  outboundHeaders.delete("x-zevium-key");
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  outboundHeaders.delete("content-length");
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  outboundHeaders.delete("cookie");
  outboundHeaders.set("host", normalized.hostname);
  outboundHeaders.set("x-zevium-request-id", requestId);
  outboundHeaders.set("x-zevium-host", normalized.hostname);
  const proxySecret = await getProxySecretFromDb();
  if (proxySecret) outboundHeaders.set("x-zevium-proxy-secret", proxySecret);

  try {
    const { CreditsManager } = await import("~/lib/server/credits");

    // Derive userId from verification response (handles different shapes)
    const vAny = verification as unknown as {
      key?: { userId?: string };
      user?: { id?: string };
      user_id?: string;
      userId?: string;
    };
    const userId = vAny.user?.id ?? vAny.key?.userId ?? vAny.userId ?? vAny.user_id ?? "";

    const upstream = await fetch(targetUrl, {
      body: request.body,
      // @ts-expect-error duplex is not in the type definition (Node.js fetch streaming)
      duplex: "half",
      headers: outboundHeaders,
      method: request.method,
    });

    // Not a success → no charge, return upstream as-is
    if (!upstream.ok) {
      throw new UpstreamNonOK(upstream);
    }

    const responseHeaders = new Headers(upstream.headers);
    // Ensure request id is included in the client response
    responseHeaders.set("x-zevium-request-id", requestId);
    // Never leak the proxy secret back to the client
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    responseHeaders.delete("x-zevium-proxy-secret");

    // Success criteria for charging:
    // - HTTP 2xx (already checked)
    // - Stream fully reaches the end to client
    // - No upstream read error / no cancel
    if (upstream.body) {
      const reader = upstream.body.getReader();
      let _aborted = false;
      const stream = new ReadableStream({
        async cancel() {
          _aborted = true;
          try {
            await reader.cancel();
          } catch (err) {
            const error = new Error("Stream cancelled by client", { cause: err });
            throw error;
          }
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              // Stream completed successfully → commit billing
              try {
                await CreditsManager.deduct({
                  amountCents: 1,
                  reason: "Zevium proxy API call",
                  reference: requestId,
                  userId,
                });
              } catch (err) {
                const error = new Error("Failed to deduct credits after successful stream", { cause: err });
                throw error;
              }
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (_e) {
            _aborted = true;
            try {
              await reader.cancel();
            } catch (err) {
              const error = new Error("Failed to cancel stream after read error", { cause: err });
              throw error;
            }
            const error = new Error("Upstream read failed", { cause: _e });
            throw error;
          }
        },
      });

      // Streaming response to client; billing is committed on pull() completion
      return new Response(stream, {
        headers: responseHeaders,
        status: upstream.status,
        statusText: upstream.statusText,
      });
    } else {
      // Non-streaming body: read fully, then bill and return
      const buf = await upstream.arrayBuffer();
      try {
        await CreditsManager.deduct({
          amountCents: 1,
          reason: "Zevium proxy API call",
          reference: requestId,
          userId,
        });
      } catch (err) {
        const error = new Error("Failed to deduct credits for non-streaming response", { cause: err });
        throw error;
      }
      return new Response(buf, {
        headers: responseHeaders,
        status: upstream.status,
        statusText: upstream.statusText,
      });
    }
  } catch (error) {
    if (error instanceof UpstreamNonOK) {
      // Return upstream error response without charging (already prevented)
      const responseHeaders = new Headers(error.response.headers);
      responseHeaders.set("x-zevium-request-id", requestId);
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      responseHeaders.delete("x-zevium-proxy-secret");
      return new Response(error.response.body, {
        headers: responseHeaders,
        status: error.response.status,
        statusText: error.response.statusText,
      });
    }
    return jsonWithRequestId(502, "Upstream request failed", requestId);
  }
};

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
