import { defaultKeyHasher } from "@better-auth/api-key";
import { createFileRoute } from "@tanstack/react-router";
import { eq, sql } from "drizzle-orm";

import { db, schema } from "~/db";
import { serverEnv } from "~/env/server";
import { getHostCost, normalizeHost } from "~/lib/server/proxy-cost";
import { refundCredits, reserveCredits } from "~/lib/server/user-pool-gate";
import { ensureUserCustomer, getUserCreditedUnits, ingestProxyCall } from "~/lib/server/polar";
import {
  isHostAllowlisted,
  isLocalOrPrivateHost,
  isSelfHost,
  normalizeProxySecret,
  parseProxyAllowlist,
} from "~/lib/server/proxy-security";

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

function proxySecretHeader(): string {
  return normalizeProxySecret(serverEnv.PROXY_UPSTREAM_SECRET) ?? serverEnv.PROXY_UPSTREAM_SECRET;
}

const proxyHandler = async (request: Request) => {
  const requestId = crypto.randomUUID();
  const zeviumKey = request.headers.get("x-zevium-key");
  if (!zeviumKey) return jsonWithRequestId(401, "Missing X-Zevium-Key", requestId);
  const zeviumHostHeader = request.headers.get("x-zevium-host");
  if (!zeviumHostHeader) return jsonWithRequestId(400, "Missing X-Zevium-Host", requestId);

  // 1. Cheap host checks (before any DB / Redis / network).
  let normalized: { hostname: string; port: string };
  try {
    const host = normalizeHost(zeviumHostHeader);
    const url = new URL(`https://${host}`);
    normalized = { hostname: host, port: url.port || "443" };
  } catch {
    return jsonWithRequestId(400, "Invalid X-Zevium-Host", requestId);
  }
  if (isSelfHost(normalized.hostname, serverEnv.PROXY_PUBLIC_HOST)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }
  if (await isLocalOrPrivateHost(normalized.hostname)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  const allowlist = parseProxyAllowlist(serverEnv.PROXY_ALLOWED_HOSTS);
  if (allowlist.length === 0) {
    return jsonWithRequestId(503, "Proxy host allowlist is not configured", requestId);
  }
  if (!isHostAllowlisted(normalized.hostname, allowlist)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  let cost: number;
  try {
    cost = getHostCost(normalized.hostname);
  } catch {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  const upstreamSecret = proxySecretHeader();

  // 2. Plugin gate (atomic guarded decrement on remaining > 0).
  const { authServer } = await import("~/lib/server/auth");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let verification: any;
  try {
    verification = await authServer.api.verifyApiKey({
      body: { key: zeviumKey, permissions: { api: ["read"] } },
    });
  } catch (err) {
    return jsonWithRequestId(500, err instanceof Error ? err.message : "verifyApiKey failed", requestId);
  }

  if (!verification.valid) {
    const code = verification.error?.code as string | undefined;
    if (code === "RATE_LIMITED") {
      // consumeRemaining already ran before consumeRateLimit; refund the
      // decrement in a single UPDATE-by-hash to avoid the select→update race
      // (two concurrent rate-limited calls both refunding the same row).
      const hashed = await defaultKeyHasher(zeviumKey);
      await db
        .update(schema.apikey)
        .set({ remaining: sql`${schema.apikey.remaining} + 1` })
        .where(eq(schema.apikey.key, hashed));
      return jsonWithRequestId(429, "Rate limit exceeded", requestId);
    }
    if (code === "USAGE_EXCEEDED") return jsonWithRequestId(429, "Usage exceeded", requestId);
    return jsonWithRequestId(
      401,
      (verification.error?.message as string | undefined) ?? "Failed to verify API key",
      requestId,
    );
  }

  const key = verification.key as { id: string; referenceId?: string } | null;
  if (!key?.referenceId) {
    return jsonWithRequestId(401, "API key has no owning user", requestId);
  }
  const userId = key.referenceId;

  // 3. User-pool money gate (Redis SDK; non-atomic check+increment).
  //    Lazy-create the Polar customer on first call so the user always has
  //    one before the gate runs (covers users created before the plugin was
  //    wired). If Polar is down, the gate surfaces 0 credits (which 402s).
  await ensureUserPool(userId);

  const credited = await getUserCreditedUnits(userId);
  const reserved = await reserveCredits(userId, credited, cost);
  if (!reserved) {
    // Refund the plugin's `remaining` decrement we already consumed.
    await db
      .update(schema.apikey)
      .set({ remaining: sql`${schema.apikey.remaining} + 1` })
      .where(eq(schema.apikey.id, key.id));
    return jsonWithRequestId(402, "Insufficient credits", requestId);
  }

  // 4. Build target URL and fetch.
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(originalUrl);
  targetUrl.protocol = "https:";
  targetUrl.hostname = normalized.hostname;
  targetUrl.port = normalized.port;
  targetUrl.pathname = targetUrl.pathname.replace(/^\/*api\/*proxy/i, "");

  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("x-zevium-key");
  outboundHeaders.delete("content-length");
  outboundHeaders.delete("cookie");
  outboundHeaders.set("host", normalized.hostname);
  outboundHeaders.set("x-zevium-request-id", requestId);
  outboundHeaders.set("x-zevium-host", normalized.hostname);
  outboundHeaders.set("x-zevium-proxy-secret", upstreamSecret);

  // 5. State machine: reserve -> commit (2xx + body-complete) | refund (non-2xx / cancel / read err).
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
      // Synchronous because route handlers cannot reach Cloudflare's
      // ExecutionContext for `waitUntil`. Adds ~50-200 ms of Polar
      // latency per 2xx call.
      await ingestProxyCall({
        costUnits: cost,
        host: normalized.hostname,
        method: request.method,
        requestId,
        status,
        userId,
      });
    } catch {
      // Ingest failure is drift; the gate is already past. A periodic
      // reconcile (v2) corrects the drift.
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

/** Best-effort lazy Polar customer creation for legacy users. */
async function ensureUserPool(userId: string): Promise<void> {
  // The `@polar-sh/better-auth` plugin auto-creates the Polar customer on
  // signup; this is only a backfill for users created before the plugin
  // was wired. If Polar is down, the next gate call will retry. Errors
  // are swallowed: the gate then sees 0 `creditedUnits` and returns 402.
  try {
    await ensureUserCustomer({ userId });
  } catch {
    // Swallowed: gate will surface 0 credits (which 402s) on failure.
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
