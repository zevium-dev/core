import { defaultKeyHasher } from "@better-auth/api-key";
import { createFileRoute } from "@tanstack/react-router";
import { eq, sql } from "drizzle-orm";

import { authServer } from "~/lib/server/auth";
import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { extractHostname, resolveProxyTarget } from "~/lib/server/proxy-cost";
import { ensureUserCustomer, getUserCreditedUnits, ingestProxyCall } from "~/lib/server/polar";
import { isLocalOrPrivateHost, isSelfHost, normalizeProxySecret } from "~/lib/server/proxy-security";
import { refundCredits, reserveCredits } from "~/lib/server/user-pool-gate";

/** Shape consumed from better-auth's verifyApiKey result. */
interface VerifyResult {
  error: { code?: string; message?: unknown } | null;
  key: { id: string; referenceId?: string } | null;
  valid: boolean;
}

class UpstreamNonOK extends Error {
  response: Response;
  constructor(response: Response) {
    super("Upstream response not OK");
    this.response = response;
  }
}

function jsonWithRequestId(status: number, message: string, requestId: string) {
  return Response.json({ error: message }, { headers: { "x-zevium-request-id": requestId }, status });
}

const proxyHandler = async (request: Request) => {
  const requestId = crypto.randomUUID();
  const zeviumKey = request.headers.get("x-zevium-key");
  if (!zeviumKey) return jsonWithRequestId(401, "Missing X-Zevium-Key", requestId);

  // 1. Parse {orgSlug}/{projectSlug}/{endpoint...} from the URL.
  const originalUrl = new URL(request.url);
  const pathAfterProxy = originalUrl.pathname.replace(/^\/*api\/*proxy\/*/i, "");
  const segments = pathAfterProxy.split("/").filter(Boolean);
  if (segments.length < 3) {
    return jsonWithRequestId(400, "Expected /api/proxy/{orgSlug}/{projectSlug}/{endpoint...}", requestId);
  }
  const orgSlug = segments[0]!;
  const projectSlug = segments[1]!;
  const endpointPath = `/${segments.slice(2).join("/")}`;

  // 2. Resolve project → OpenAPI spec → upstream URL + cost.
  const target = await resolveProxyTarget(orgSlug, projectSlug, request.method, endpointPath);
  if (!target) {
    return jsonWithRequestId(404, "API not found or not published", requestId);
  }

  // 3. SSRF protection: reject local/private/self-host upstreams.
  const upstreamHostname = extractHostname(target.upstreamUrl);
  if (!upstreamHostname) {
    return jsonWithRequestId(502, "Invalid upstream URL in API spec", requestId);
  }
  if (isSelfHost(upstreamHostname, serverEnv.PROXY_PUBLIC_HOST)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }
  if (await isLocalOrPrivateHost(upstreamHostname)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  const cost = target.cost;
  const upstreamSecret = normalizeProxySecret(serverEnv.PROXY_UPSTREAM_SECRET) ?? serverEnv.PROXY_UPSTREAM_SECRET;

  // 4. Plugin gate (atomic guarded decrement on remaining > 0).
  let verification: VerifyResult;
  try {
    verification = await authServer.api.verifyApiKey({
      body: { key: zeviumKey, permissions: { api: ["read"] } },
    });
  } catch (err) {
    return jsonWithRequestId(500, err instanceof Error ? err.message : "verifyApiKey failed", requestId);
  }

  if (!verification.valid) {
    const code = verification.error?.code;
    if (code === "RATE_LIMITED") {
      const hashed = await defaultKeyHasher(zeviumKey);
      await db
        .update(schema.apikey)
        .set({ remaining: sql`${schema.apikey.remaining} + 1` })
        .where(eq(schema.apikey.key, hashed));
      return jsonWithRequestId(429, "Rate limit exceeded", requestId);
    }
    if (code === "USAGE_EXCEEDED") return jsonWithRequestId(429, "Usage exceeded", requestId);
    const rawMessage = verification.error?.message;
    return jsonWithRequestId(401, typeof rawMessage === "string" ? rawMessage : "Failed to verify API key", requestId);
  }

  const key = verification.key;
  if (!key?.referenceId) {
    return jsonWithRequestId(401, "API key has no owning user", requestId);
  }
  const userId = key.referenceId;

  // 5. User-pool money gate.
  try {
    await ensureUserCustomer({ userId });
  } catch {
    // Swallowed: gate surfaces 0 credits (402) if Polar is down.
  }

  const credited = await getUserCreditedUnits(userId);
  const reserved = await reserveCredits(userId, credited, cost);
  if (!reserved) {
    await db
      .update(schema.apikey)
      .set({ remaining: sql`${schema.apikey.remaining} + 1` })
      .where(eq(schema.apikey.id, key.id));
    return jsonWithRequestId(402, "Insufficient credits", requestId);
  }

  // 6. Build target URL and fetch.
  const targetUrl = new URL(target.upstreamUrl + originalUrl.search);

  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("x-zevium-key");
  outboundHeaders.delete("content-length");
  outboundHeaders.delete("cookie");
  outboundHeaders.set("host", upstreamHostname);
  outboundHeaders.set("x-zevium-request-id", requestId);
  outboundHeaders.set("x-zevium-host", upstreamHostname);
  outboundHeaders.set("x-zevium-proxy-secret", upstreamSecret);

  // 7. State machine: reserve -> commit (2xx) | refund (non-2xx / cancel).
  let phase: "reserved" | "committed" | "refunded" = "reserved";

  const refundBoth = async () => {
    if (phase !== "reserved") return;
    phase = "refunded";
    await Promise.allSettled([
      refundCredits(userId, cost),
      db
        .update(schema.apikey)
        .set({ remaining: sql`${schema.apikey.remaining} + 1` })
        .where(eq(schema.apikey.id, key.id)),
    ]);
  };

  const commitAndIngest = async (status: number) => {
    if (phase !== "reserved") return;
    phase = "committed";
    try {
      await ingestProxyCall({
        costUnits: cost,
        host: upstreamHostname,
        method: request.method,
        requestId,
        status,
        userId,
      });
    } catch {
      // Ingest failure is drift; periodic reconcile corrects it.
    }
  };

  const timeoutSignal = AbortSignal.timeout(serverEnv.PROXY_REQUEST_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([timeoutSignal, request.signal]);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      body: request.body,
      duplex: "half",
      headers: outboundHeaders,
      method: request.method,
      redirect: "error",
      signal: combinedSignal,
    });
  } catch (err) {
    await refundBoth();
    if (err instanceof Error && err.name === "TimeoutError") {
      return jsonWithRequestId(504, "Upstream request timed out", requestId);
    }
    if (err instanceof Error && err.name === "TypeError" && /redirect/i.test(err.message)) {
      return jsonWithRequestId(502, "Upstream redirected (not allowed)", requestId);
    }
    return jsonWithRequestId(502, "Upstream request failed", requestId);
  }

  if (!upstream.ok) {
    await refundBoth();
    throw new UpstreamNonOK(upstream);
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("x-zevium-request-id", requestId);
  responseHeaders.delete("x-zevium-proxy-secret");

  if (!upstream.body) {
    await commitAndIngest(upstream.status);
    return new Response(null, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async cancel() {
      await reader.cancel().catch(() => undefined);
      await refundBoth();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await commitAndIngest(upstream.status);
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        await refundBoth();
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  return new Response(stream, {
    headers: responseHeaders,
    status: upstream.status,
    statusText: upstream.statusText,
  });
};

export const Route = createFileRoute("/api/proxy/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyHandler(request),
      POST: ({ request }) => proxyHandler(request),
      PUT: ({ request }) => proxyHandler(request),
      PATCH: ({ request }) => proxyHandler(request),
      DELETE: ({ request }) => proxyHandler(request),
    },
  },
});
