import type { Admission } from "./admit";
import type { ForwardResult } from "./forward";
import type { SettlementUsage } from "./wallet";
import { filterResponseHeaders } from "./headers";
import { applyDeprecationHeaders } from "./deprecation";
import { jsonError } from "./errors";

function qualityOutcomeForStatus(
  status: number,
): SettlementUsage["qualityOutcome"] {
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "server_error";
  return "network_error";
}

/** Settle/refund through the durable wallet outbox, then return the body stream. */
export async function finalize(
  admission: Admission,
  result: ForwardResult,
  now: () => number = Date.now,
): Promise<Response> {
  const {
    requestId,
    reservationId,
    wallet,
    usedFree,
    unmetered,
    published,
    verified,
    matched,
    immutableUsageIdentity,
    keyBudget,
    freeTierScope,
    releaseChallenge,
    gatewayRelease,
    started,
    cost,
    route,
  } = admission;
  const upstreamRes = "response" in result ? result.response : undefined;
  const status = upstreamRes?.status ?? 502;
  const success = status >= 200 && status < 300;
  const usageMeta: SettlementUsage = {
    organizationId: published.organizationId,
    consumerClerkOrgId: verified.orgId,
    projectId: published.projectId,
    ...immutableUsageIdentity,
    endpoint: matched.pathTemplate,
    method: matched.method,
    status,
    latencyMs: now() - started,
    keyId: upstreamRes ? keyBudget.keyId : verified.keyId,
    billingOutcome: !success
      ? "refunded"
      : usedFree || unmetered
        ? "free"
        : "settled",
    qualityOutcome: upstreamRes
      ? qualityOutcomeForStatus(status)
      : "network_error",
    ...(upstreamRes && releaseChallenge ? { releaseChallenge } : {}),
    ...(upstreamRes && gatewayRelease ? { gatewayRelease } : {}),
  };
  if (usedFree || unmetered) {
    if (usedFree && !success)
      await wallet.refundFreeTier({ ...freeTierScope, nowMs: now() });
    await wallet.enqueueFreeUsage(reservationId, usageMeta);
  } else if (success) {
    await wallet.settle(reservationId, usageMeta);
  } else {
    await wallet.refund(reservationId, usageMeta);
  }
  if ("timedOut" in result) {
    return jsonError(
      502,
      result.timedOut ? "upstream_timeout" : "upstream_error",
      result.timedOut
        ? "Upstream did not respond in time"
        : "Upstream request failed",
      requestId,
    );
  }
  const outHeaders = filterResponseHeaders(result.response.headers);
  outHeaders.set("x-zevium-request-id", requestId);
  outHeaders.set("x-zevium-cost", String(usedFree ? 0 : cost));
  if (usedFree) outHeaders.set("x-zevium-free-tier", "1");
  applyDeprecationHeaders(outHeaders, published, route);
  return new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers: outHeaders,
  });
}
