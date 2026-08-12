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
import { jsonError } from "./errors";
import { paymentRequiredResponse } from "./x402";
import { assertSafeUpstreamTarget } from "./upstream-safety";
import { SpecSourceUnavailableError } from "./spec-source";

const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;

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
  publisherHandle: string;
  projectSlug: string;
  /** Remainder path under /gateway/:org/:project */
  remainderPath: string;
};

export function parseGatewayPath(pathname: string): GatewayRoute | null {
  // /gateway/:publisherHandle/:projectSlug/*
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "gateway") return null;
  if (!parts[1] || !parts[2]) return null;
  const publisherHandle = parts[1];
  const projectSlug = parts[2];
  const rest = parts.slice(3);
  const remainderPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { publisherHandle, projectSlug, remainderPath };
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
    // x402: unauthenticated calls never execute — no unmetered path.
    return paymentRequiredResponse(requestId, "API key required", {
      reason: "missing_api_key",
    });
  }

  const verified = await deps.keyVerifier.verify(secret);
  if (!verified) {
    return paymentRequiredResponse(requestId, "Invalid API key", {
      reason: "invalid_api_key",
    });
  }

  let published;
  try {
    published = await deps.specSource.getPublishedSpec(
      route.publisherHandle,
      route.projectSlug,
    );
  } catch (error) {
    if (error instanceof SpecSourceUnavailableError) {
      return jsonError(
        503,
        "gateway_unavailable",
        "Gateway configuration is temporarily unavailable",
        requestId,
      );
    }
    throw error;
  }
  if (!published) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
  }

  // Marketplace access: public projects accept any authenticated key.
  // Private projects only accept keys whose org owns the project — foreign
  // keys get 404 (never leak that a private project exists) not 401/403.
  if (
    published.visibility !== "public" &&
    verified.orgId !== published.clerkOrgId
  ) {
    return jsonError(404, "project_not_found", "Unknown project", requestId);
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

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(
      joinUpstreamUrl(matched.upstreamBaseUrl, route.remainderPath),
    );
    assertSafeUpstreamTarget(upstreamUrl);
  } catch {
    return jsonError(
      422,
      "unsafe_upstream",
      "This API's upstream URL is not permitted",
      requestId,
    );
  }
  const incoming = new URL(request.url);
  upstreamUrl.search = incoming.search;

  const cost = matched.pricing.cost;
  const freeTier = matched.pricing.freeTier;
  const reservationId = requestId;

  // Wallet DO keyed by the CONSUMER's Clerk org id — the caller's org pays,
  // never the publisher's, even when they differ (marketplace calls).
  const walletId = env.WALLET.idFromName(verified.orgId);
  const wallet = env.WALLET.get(walletId);
  const freeTierScope = {
    clerkOrgId: verified.orgId,
    projectId: published.projectId,
    method: matched.method,
    pathTemplate: matched.pathTemplate,
  };

  let usedFree = false;
  let unmetered = false;
  if (cost === 0) {
    const authorization = await wallet.authorizeKey(
      verified.keyId,
      verified.orgId,
      (deps.now ?? Date.now)(),
    );
    if (authorization.status === "rejected") {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status: authorization.reason === "insufficient_credits" ? 402 : 403,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      if (authorization.reason === "insufficient_credits") {
        return paymentRequiredResponse(requestId, "Insufficient credits", {
          reason: "insufficient_credits",
          available: authorization.available ?? 0,
          cost: 0,
        });
      }
      return jsonError(
        403,
        authorization.reason,
        authorization.reason === "key_untracked"
          ? "API key is not managed by Zevium"
          : "API key is disabled",
        requestId,
      );
    }
    unmetered = true;
  } else if (freeTier !== undefined && freeTier > 0) {
    const freeResult = await wallet.consumeFreeTier(freeTier, {
      keyId: verified.keyId,
      ...freeTierScope,
      nowMs: (deps.now ?? Date.now)(),
    });
    if (freeResult.status === "consumed") {
      usedFree = true;
    } else if (
      freeResult.status === "rejected" &&
      freeResult.reason === "insufficient_credits"
    ) {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status: 402,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      return paymentRequiredResponse(requestId, "Insufficient credits", {
        reason: "insufficient_credits",
        available: freeResult.available ?? 0,
        cost: 0,
      });
    } else if (
      freeResult.status === "rejected" &&
      (freeResult.reason === "key_disabled" ||
        freeResult.reason === "key_untracked")
    ) {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status: 403,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      return jsonError(
        403,
        freeResult.reason,
        freeResult.reason === "key_untracked"
          ? "API key is not managed by Zevium"
          : "API key is disabled",
        requestId,
      );
    }
  }

  if (!usedFree && !unmetered) {
    const reserve = await wallet.reserve(reservationId, cost, {
      keyId: verified.keyId,
      clerkOrgId: verified.orgId,
    });
    if (reserve.status === "insufficient") {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost,
        status: 402,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      // x402: zero/insufficient balance blocks the call — same payment shape
      // as an unauthenticated request, plus the balance detail agents need.
      return paymentRequiredResponse(requestId, "Insufficient credits", {
        reason: "insufficient_credits",
        available: reserve.available,
        cost: reserve.cost,
      });
    }
    if (
      reserve.status === "rejected" &&
      (reserve.reason === "key_disabled" ||
        reserve.reason === "key_untracked" ||
        reserve.reason === "key_cap_exceeded")
    ) {
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost,
        status: 403,
        outcome: "blocked",
        latencyMs: (deps.now ?? Date.now)() - started,
        reservationId,
      });
      return jsonError(
        403,
        reserve.reason,
        reserve.reason === "key_untracked"
          ? "API key is not managed by Zevium"
          : reserve.reason === "key_disabled"
            ? "API key is disabled"
            : "Monthly credit cap reached for this key",
        requestId,
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

  const upstreamHeaders = filterRequestHeaders(request.headers);
  for (const [name, value] of Object.entries(published.upstreamHeaders ?? {})) {
    upstreamHeaders.set(name, value);
  }
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  init.signal = controller.signal;
  let upstreamRes: Response;
  try {
    upstreamRes = await fetchImpl(upstreamUrl.toString(), init);
  } catch (err) {
    if (!usedFree && !unmetered) {
      await wallet.refund(reservationId);
    } else if (usedFree) {
      await wallet.refundFreeTier({
        ...freeTierScope,
        nowMs: (deps.now ?? Date.now)(),
      });
    }
    emitUsage(ctx, deps, {
      requestId,
      organizationId: published.organizationId,
      consumerClerkOrgId: verified.orgId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.publisherHandle,
      projectSlug: route.projectSlug,
      method: matched.method,
      pathTemplate: matched.pathTemplate,
      cost: usedFree ? 0 : cost,
      status: 502,
      outcome: "refunded",
      latencyMs: (deps.now ?? Date.now)() - started,
      reservationId,
    });
    return jsonError(
      502,
      controller.signal.aborted ? "upstream_timeout" : "upstream_error",
      controller.signal.aborted
        ? "Upstream did not respond in time"
        : "Upstream request failed",
      requestId,
    );
  } finally {
    clearTimeout(timeout);
  }

  const status = upstreamRes.status;
  const latencyMs = (deps.now ?? Date.now)() - started;
  const usageMeta: SettlementUsage = {
    organizationId: published.organizationId,
    consumerClerkOrgId: verified.orgId,
    projectId: published.projectId,
    endpoint: matched.pathTemplate,
    method: matched.method,
    status,
    latencyMs,
    keyId: verified.keyId,
  };

  if (usedFree || unmetered) {
    // Unmetered paths skip reserve/settle; successful calls still enter analytics.
    if (status >= 200 && status < 300) {
      await wallet.enqueueFreeUsage(reservationId, usageMeta);
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status,
        outcome: usedFree ? "free" : "settled",
        latencyMs,
        reservationId,
      });
    } else {
      if (usedFree) {
        await wallet.refundFreeTier({
          ...freeTierScope,
          nowMs: (deps.now ?? Date.now)(),
        });
      }
      emitUsage(ctx, deps, {
        requestId,
        organizationId: published.organizationId,
        consumerClerkOrgId: verified.orgId,
        projectId: published.projectId,
        keyId: verified.keyId,
        orgSlug: route.publisherHandle,
        projectSlug: route.projectSlug,
        method: matched.method,
        pathTemplate: matched.pathTemplate,
        cost: 0,
        status,
        outcome: "refunded",
        latencyMs,
        reservationId,
      });
    }
  } else if (status >= 200 && status < 300) {
    await wallet.settle(reservationId, usageMeta);
    emitUsage(ctx, deps, {
      requestId,
      organizationId: published.organizationId,
      consumerClerkOrgId: verified.orgId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.publisherHandle,
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
      consumerClerkOrgId: verified.orgId,
      projectId: published.projectId,
      keyId: verified.keyId,
      orgSlug: route.publisherHandle,
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
      `<https://zevium.dev/catalogue/${route.publisherHandle}/${route.projectSlug}>; rel="deprecation"`,
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
