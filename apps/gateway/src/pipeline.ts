/**
 * Metered gateway pipeline:
 * verify key → load spec → match op → free-tier or reserve → proxy → settle/refund → usage.
 */

import { joinUpstreamUrl, matchOperation, parseSpec } from "@zevium/shared";
import type { SettlementUsage, WalletDO } from "./wallet";
import { extractApiKey, type KeyVerifier } from "./key-verifier";
import type { SpecSource } from "./spec-source";
import { filterRequestHeaders, filterResponseHeaders } from "./headers";
import type { UsageSink } from "./usage";

export type PipelineEnv = {
  WALLET: DurableObjectNamespace<WalletDO>;
};

export type PipelineDeps = {
  keyVerifier: KeyVerifier;
  specSource: SpecSource;
  usageSink: UsageSink;
  /** Upstream fetch — inject mock in tests. */
  fetchImpl?: typeof fetch;
  /** Id generator for request/reservation ids. */
  idGenerator?: () => string;
  now?: () => number;
};

export type GatewayRoute = {
  orgSlug: string;
  projectSlug: string;
  /** Remainder path under /gateway/:org/:project */
  remainderPath: string;
};

export function parseGatewayPath(pathname: string): GatewayRoute | null {
  // /gateway/:orgSlug/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "gateway") return null;
  if (!parts[1] || !parts[2]) return null;
  const orgSlug = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { orgSlug, projectSlug, remainderPath };
}

function defaultId(): string {
  return crypto.randomUUID();
}

export async function handleGatewayRequest(
  request: Request,
  env: PipelineEnv,
  deps: PipelineDeps,
  ctx: ExecutionContext,
  route: GatewayRoute,
): Promise<Response> {
  const started = (deps.now ?? Date.now)();
  const requestId = (deps.idGenerator ?? defaultId)();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const secret = extractApiKey(request);
  if (!secret) {
    return jsonError(401, "missing_api_key", "API key required", requestId);
  }

  const verified = await deps.keyVerifier.verify(secret);
  if (!verified) {
    return jsonError(401, "invalid_api_key", "Invalid API key", requestId);
  }

  const published = await deps.specSource.getPublishedSpec(
    route.orgSlug,
    route.projectSlug,
  );
  if (!published) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
  }

  // Key subject must match project Clerk org id (wallet DO routing key).
  if (verified.orgId !== published.clerkOrgId) {
    return jsonError(
      401,
      "org_mismatch",
      "Key not authorized for this org",
      requestId,
    );
  }

  let parsed;
  try {
    parsed = parseSpec(published.spec);
  } catch {
    return jsonError(
      404,
      "invalid_spec",
      "Published spec unreadable",
      requestId,
    );
  }

  const matched = matchOperation(parsed, request.method, route.remainderPath);
  if (!matched) {
    return jsonError(404, "route_not_found", "Unknown route", requestId);
  }

  if (!matched.upstreamBaseUrl) {
    return jsonError(
      404,
      "no_upstream",
      "Spec has no servers[0].url",
      requestId,
    );
  }

  const cost = matched.pricing.cost;
  const freeTier = matched.pricing.freeTier;
  const reservationId = requestId;

  // Wallet DO keyed by Clerk org id (idFromName(clerkOrgId)).
  const walletId = env.WALLET.idFromName(published.clerkOrgId);
  const wallet = env.WALLET.get(walletId);

  let usedFree = false;
  if (freeTier !== undefined && freeTier > 0) {
    const freeResult = await wallet.consumeFreeTier(
      verified.keyId,
      freeTier,
      (deps.now ?? Date.now)(),
    );
    if (freeResult.status === "consumed") {
      usedFree = true;
    }
  }

  if (!usedFree) {
    const reserve = await wallet.reserve(reservationId, cost);
    if (reserve.status === "insufficient") {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.orgSlug,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost,
        status: 402,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      return jsonError(
        402,
        "insufficient_credits",
        "Insufficient credits",
        requestId,
        { available: reserve.available, cost: reserve.cost },
      );
    }
    if (reserve.status !== "reserved" && reserve.status !== "duplicate") {
      return jsonError(
        500,
        "reserve_failed",
        "Credit reservation failed",
        requestId,
      );
    }
  }

  const upstreamUrl = new URL(
    joinUpstreamUrl(matched.upstreamBaseUrl, route.remainderPath),
  );
  const incoming = new URL(request.url);
  upstreamUrl.search = incoming.search;

  const upstreamHeaders = filterRequestHeaders(request.headers);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by fetch when body is a stream.
    init.duplex = "half";
  }
  let upstreamRes: Response;
  try {
    upstreamRes = await fetchImpl(upstreamUrl.toString(), init);
  } catch (err) {
    if (!usedFree) {
      await wallet.refund(reservationId);
    }
    const message = err instanceof Error ? err.message : "upstream error";
    emitUsage(ctx, deps, {
      requestId,
      organizationId: published.organizationId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.orgSlug,
      projectSlug: route.projectSlug,
      method: matched.method,
      pathTemplate: matched.pathTemplate,
      cost: usedFree ? 0 : cost,
      status: 502,
      outcome: "refunded",
      latencyMs: (deps.now ?? Date.now)() - started,
      reservationId,
    });
    return jsonError(502, "upstream_error", message, requestId);
  }

  const status = upstreamRes.status;
  const latencyMs = (deps.now ?? Date.now)() - started;
  const usageMeta: SettlementUsage = {
    organizationId: published.organizationId,
    projectId: published.projectId,
    endpoint: matched.pathTemplate,
    method: matched.method,
    status,
    latencyMs,
    keyId: verified.keyId,
  };

  if (usedFree) {
    // Free path: no reserve/settle; still emit usage with credits 0.
    if (status >= 200 && status < 300) {
      await wallet.enqueueFreeUsage(reservationId, usageMeta);
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.orgSlug,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status,
        outcome: "free",
        latencyMs,
        reservationId,
      });
    } else {
      // Free unit already consumed; non-2xx still records usage at 0 credits.
      await wallet.enqueueFreeUsage(reservationId, {
        ...usageMeta,
        status,
      });
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.orgSlug,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status,
        outcome: "free",
        latencyMs,
        reservationId,
      });
    }
  } else if (status >= 200 && status < 300) {
    await wallet.settle(reservationId, usageMeta);
    emitUsage(ctx, deps, {
      requestId,
      organizationId: published.organizationId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.orgSlug,
      projectSlug: route.projectSlug,
      method: matched.method,
      pathTemplate: matched.pathTemplate,
      cost,
      status,
      outcome: "settled",
      latencyMs,
      reservationId,
    });
  } else {
    await wallet.refund(reservationId);
    emitUsage(ctx, deps, {
      requestId,
      organizationId: published.organizationId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.orgSlug,
      projectSlug: route.projectSlug,
      method: matched.method,
      pathTemplate: matched.pathTemplate,
      cost,
      status,
      outcome: "refunded",
      latencyMs,
      reservationId,
    });
  }

  const outHeaders = filterResponseHeaders(upstreamRes.headers);
  outHeaders.set("x-zevium-request-id", requestId);
  outHeaders.set("x-zevium-cost", String(usedFree ? 0 : cost));
  if (usedFree) {
    outHeaders.set("x-zevium-free-tier", "1");
  }

  // RFC 8594 deprecation signalling — headers only, never blocks the proxied body.
  if (published.deprecatedAt !== undefined) {
    // Convex timestamps are epoch milliseconds; Deprecation wants @<seconds>.
    outHeaders.set(
      "Deprecation",
      `@${Math.floor(published.deprecatedAt / 1000)}`,
    );
    outHeaders.append(
      "Link",
      `<https://zevium.dev/catalogue/${route.orgSlug}/${route.projectSlug}>; rel="deprecation"`,
    );
    if (published.sunsetAt !== undefined) {
      outHeaders.set("Sunset", new Date(published.sunsetAt).toUTCString());
    }
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: outHeaders,
  });
}

function emitUsage(
  ctx: ExecutionContext,
  deps: PipelineDeps,
  event: Parameters<UsageSink["emit"]>[0],
): void {
  ctx.waitUntil(
    Promise.resolve(deps.usageSink.emit(event)).catch((err) => {
      console.error("usage emit failed", err);
    }),
  );
}

function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = { error: code, message, requestId };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      body[k] = v;
    }
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-zevium-request-id": requestId,
    },
  });
}
