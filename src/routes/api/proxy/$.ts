import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  isHostAllowlisted,
  isLocalOrPrivateHost,
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

const PROXY_CALL_COST_CENTS = 1;

const ApiKeyVerificationUserShapeZod = z.object({
  key: z
    .object({
      userId: z.string().optional(),
    })
    .optional(),
  user: z
    .object({
      id: z.string().optional(),
    })
    .optional(),
  user_id: z.string().optional(),
  userId: z.string().optional(),
});

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
    const rawMessage = verification.error.message;
    const errorMessage =
      typeof rawMessage === "string" ? rawMessage : (rawMessage?.message ?? "Failed to verify API key");
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

  // Fail closed for local/private or unresolvable hostnames.
  if (await isLocalOrPrivateHost(normalized.hostname)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  const { serverEnv } = await import("~/env/server");

  // Runtime allowlist is required for proxy safety.
  const allowlist = parseProxyAllowlist(serverEnv.PROXY_ALLOWED_HOSTS);
  if (allowlist.length === 0) {
    return jsonWithRequestId(503, "Proxy host allowlist is not configured", requestId);
  }
  if (!isHostAllowlisted(normalized.hostname, allowlist)) {
    return jsonWithRequestId(403, "Host not allowed", requestId);
  }

  const proxySecret = normalizeProxySecret(serverEnv.PROXY_UPSTREAM_SECRET) ?? serverEnv.PROXY_UPSTREAM_SECRET;

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
  outboundHeaders.set("x-zevium-proxy-secret", proxySecret);

  let refundReservedCharge: (() => Promise<void>) | null = null;

  try {
    const { CreditsManager } = await import("~/lib/server/credits");

    // Derive userId from verification response (handles different response shapes)
    const verificationShape = ApiKeyVerificationUserShapeZod.safeParse(verification);
    const userId = verificationShape.success
      ? (verificationShape.data.user?.id ??
        verificationShape.data.key?.userId ??
        verificationShape.data.userId ??
        verificationShape.data.user_id)
      : undefined;
    if (!userId) {
      return jsonWithRequestId(401, "API key verification did not include a user id", requestId);
    }

    let chargeState: "committed" | "not_reserved" | "refunded" | "reserved" = "not_reserved";
    const refundReservedChargeInternal = async () => {
      if (chargeState !== "reserved") return;

      chargeState = "refunded";
      try {
        await CreditsManager.add({
          amountCents: PROXY_CALL_COST_CENTS,
          description: "Refund for failed Zevium proxy API call",
          reference: requestId,
          userId,
        });
      } catch (error) {
        chargeState = "reserved";
        throw error;
      }
    };
    const commitReservedCharge = () => {
      if (chargeState !== "reserved") return;
      chargeState = "committed";
    };
    refundReservedCharge = refundReservedChargeInternal;

    try {
      await CreditsManager.deduct({
        amountCents: PROXY_CALL_COST_CENTS,
        reason: "Zevium proxy API call",
        reference: requestId,
        userId,
      });
      chargeState = "reserved";
    } catch (err) {
      if (err instanceof Error && err.message === "Insufficient credits") {
        return jsonWithRequestId(402, "Insufficient credits", requestId);
      }
      return jsonWithRequestId(503, "Billing is temporarily unavailable", requestId);
    }

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        body: request.body,
        duplex: "half",
        headers: outboundHeaders,
        method: request.method,
      });
    } catch {
      try {
        await refundReservedChargeInternal();
      } catch {
        return jsonWithRequestId(503, "Billing is temporarily unavailable", requestId);
      }
      return jsonWithRequestId(502, "Upstream request failed", requestId);
    }

    // Not a success → no charge, return upstream as-is
    if (!upstream.ok) {
      try {
        await refundReservedChargeInternal();
      } catch {
        return jsonWithRequestId(503, "Billing is temporarily unavailable", requestId);
      }
      throw new UpstreamNonOK(upstream);
    }

    const responseHeaders = new Headers(upstream.headers);
    // Ensure request id is included in the client response
    responseHeaders.set("x-zevium-request-id", requestId);
    // Never leak the proxy secret back to the client
    responseHeaders.delete("x-zevium-proxy-secret");

    if (!upstream.body) {
      commitReservedCharge();
      return new Response(null, {
        headers: responseHeaders,
        status: upstream.status,
        statusText: upstream.statusText,
      });
    }

    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async cancel() {
        await reader.cancel().catch(() => undefined);
        await refundReservedChargeInternal().catch(() => undefined);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            commitReservedCharge();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (readErr) {
          await reader.cancel().catch(() => undefined);
          try {
            await refundReservedChargeInternal();
          } catch (refundErr) {
            controller.error(new Error("Failed to refund credits after upstream read error", { cause: refundErr }));
            return;
          }
          controller.error(new Error("Upstream read failed", { cause: readErr }));
        }
      },
    });

    return new Response(stream, {
      headers: responseHeaders,
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    if (error instanceof UpstreamNonOK) {
      // Return upstream error response without charging (already prevented)
      const responseHeaders = new Headers(error.response.headers);
      responseHeaders.set("x-zevium-request-id", requestId);
      responseHeaders.delete("x-zevium-proxy-secret");
      return new Response(error.response.body, {
        headers: responseHeaders,
        status: error.response.status,
        statusText: error.response.statusText,
      });
    }

    if (refundReservedCharge) {
      try {
        await refundReservedCharge();
      } catch {
        return jsonWithRequestId(503, "Billing is temporarily unavailable", requestId);
      }
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
