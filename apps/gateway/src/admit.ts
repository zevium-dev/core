import { isWalletSession, verifyWalletSession } from "./wallet-session";
import {
  joinUpstreamUrl,
  matchOperation,
  signAdmissionProof,
} from "@zevium/shared";
import type { KeyBudgetSnapshot } from "./wallet";
import { extractApiKey, type VerifyOutcome } from "./key-verifier";
import { SpecSourceUnavailableError, getParsedSpec } from "./spec-source";
import { jsonError } from "./errors";
import { paymentRequiredResponse } from "./payment-required";
import { assertSafeUpstreamTarget } from "./upstream-safety";
import { applyDeprecationHeaders } from "./deprecation";
import type { GatewayRoute, PipelineDeps, PipelineEnv } from "./pipeline";

import { prepareTokenRequest } from "./token-metering";

const RELEASE_CHALLENGE_RE = /^[0-9a-f]{64}$/;
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;

/** Authenticate, resolve the immutable route and reserve the consumer's credits. */
export async function admit(
  request: Request,
  env: PipelineEnv,
  deps: PipelineDeps,
  route: GatewayRoute,
  requestId: string,
  started: number,
) {
  const secret = extractApiKey(request);
  if (!secret && !deps.authenticatedKey) {
    // Unauthenticated calls never execute — no unmetered path.
    return paymentRequiredResponse(requestId, "API key required", {
      reason: "missing_api_key",
    });
  }

  const verifier = isWalletSession(secret ?? "")
    ? {
        verify: (token: string) =>
          verifyWalletSession(
            token,
            deps.machinePayments?.signingSecret ?? "",
            new URL(request.url).origin,
            (deps.now ?? Date.now)(),
          ),
        verifyWithStatus: undefined,
      }
    : deps.keyVerifier;
  const outcome: VerifyOutcome = deps.authenticatedKey
    ? { status: "ok", key: deps.authenticatedKey }
    : verifier.verifyWithStatus
      ? await verifier.verifyWithStatus(secret!)
      : await verifier
          .verify(secret!)
          .then((key): VerifyOutcome =>
            key ? { status: "ok", key } : { status: "invalid" },
          );
  if (outcome.status === "unavailable") {
    return jsonError(
      503,
      "verification_unavailable",
      "API key verification is temporarily unavailable",
      requestId,
    );
  }
  if (outcome.status !== "ok") {
    return paymentRequiredResponse(requestId, "Invalid API key", {
      reason: "invalid_api_key",
    });
  }
  const verified = outcome.key;
  // Wallet DO keyed by the CONSUMER's Clerk org id — the caller's org pays,
  // never the publisher's, even when they differ (marketplace calls).
  const walletId = env.WALLET.idFromName(verified.orgId);
  const wallet = env.WALLET.get(walletId);
  // Wallet sessions use the stable network/payer wallet ID as keyId, so
  // session renewal and top-ups cannot reset the request bucket.
  const rate = await wallet.consumeKeyRateLimit(verified.keyId, verified.orgId);
  if (rate.status === "rejected") {
    const status =
      rate.reason === "key_rate_limited"
        ? 429
        : rate.reason === "wallet_unavailable"
          ? 503
          : 403;
    const message =
      rate.reason === "key_rate_limited"
        ? isWalletSession(secret ?? "")
          ? "Too many requests for this wallet. Try again shortly."
          : "Too many requests for this API key. Try again shortly."
        : rate.reason === "wallet_unavailable"
          ? "Wallet temporarily unavailable"
          : rate.reason === "organization_archived"
            ? "Organization is archived"
            : rate.reason === "key_untracked"
              ? "API key is not managed by Zevium"
              : "API key is disabled";
    const response = jsonError(status, rate.reason, message, requestId);
    if (rate.retryAfterSeconds !== undefined)
      response.headers.set("Retry-After", String(rate.retryAfterSeconds));
    return response;
  }

  const releaseChallengeHeader = request.headers.get(
    "x-zevium-release-challenge",
  );
  let releaseChallenge: string | undefined;
  let gatewayRelease: string | undefined;
  if (releaseChallengeHeader !== null) {
    if (!RELEASE_CHALLENGE_RE.test(releaseChallengeHeader)) {
      return jsonError(
        400,
        "invalid_release_challenge",
        "Release challenge is invalid",
        requestId,
      );
    }
    if (!env.ZEVIUM_RELEASE || !RELEASE_SHA_RE.test(env.ZEVIUM_RELEASE)) {
      return jsonError(
        503,
        "release_identity_unavailable",
        "Gateway release identity is unavailable",
        requestId,
      );
    }
    releaseChallenge = releaseChallengeHeader;
    gatewayRelease = env.ZEVIUM_RELEASE;
  }

  let published;
  try {
    published = await deps.specSource.getPublishedSpec(
      route.publisherHandle,
      route.projectSlug,
      verified.orgId,
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
    return jsonError(404, "project_not_found", "API not found", requestId);
  }

  if (
    published.retiredAt !== undefined ||
    (published.sunsetAt !== undefined && started >= published.sunsetAt)
  ) {
    const response = jsonError(
      410,
      "sunset_reached",
      "This API has reached its published sunset",
      requestId,
    );
    applyDeprecationHeaders(response.headers, published, route);
    return response;
  }

  // Marketplace access: public projects accept any authenticated key.
  // Private projects only accept keys whose org owns the project — foreign
  // keys get 404 (never leak that a private project exists) not 401/403.
  if (
    published.visibility !== "public" &&
    verified.orgId !== published.clerkOrgId
  ) {
    return jsonError(404, "project_not_found", "API not found", requestId);
  }

  if (published.admission?.allowed === false) {
    return jsonError(
      403,
      "consumer_not_entitled",
      "This API is deprecated and no longer accepts new consumers",
      requestId,
    );
  }
  if (!env.GATEWAY_INTERNAL_SECRET) {
    return jsonError(
      503,
      "gateway_unavailable",
      "Gateway configuration is temporarily unavailable",
      requestId,
    );
  }
  const admissionProof = await signAdmissionProof(env.GATEWAY_INTERNAL_SECRET, {
    reservationId: requestId,
    consumerClerkOrgId: verified.orgId,
    projectId: published.projectId,
    routeRevision: published.specVersionId,
    policyRevision: published.admission?.policyRevision ?? 1,
    mode: published.admission?.mode ?? "open",
    admittedAt: started,
  });

  let parsed;
  try {
    parsed = getParsedSpec(published);
  } catch {
    return jsonError(
      422,
      "invalid_spec",
      "Published spec unreadable",
      requestId,
    );
  }

  let matched: ReturnType<typeof matchOperation>;
  try {
    matched = matchOperation(parsed, request.method, route.remainderPath);
  } catch {
    return jsonError(
      422,
      "invalid_spec",
      "Published endpoint pricing is invalid",
      requestId,
    );
  }
  if (!matched) {
    return jsonError(
      404,
      "route_not_found",
      "No endpoint matches this method and path",
      requestId,
    );
  }
  // Keep settlement identity total even during a rolling shared-package
  // upgrade where an older matcher result may omit the new derived field.
  const operationId =
    typeof matched.operationId === "string" && matched.operationId.trim() !== ""
      ? matched.operationId
      : typeof matched.operation.operationId === "string" &&
          matched.operation.operationId.trim() !== ""
        ? matched.operation.operationId
        : `${matched.method.toUpperCase()} ${matched.pathTemplate}`;

  if (!matched.upstreamBaseUrl) {
    return jsonError(
      404,
      "no_upstream",
      "Publisher has not configured an upstream URL",
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

  let tokenRequest: Awaited<ReturnType<typeof prepareTokenRequest>> | undefined;
  if (matched.pricing.token && matched.pricing.cost > 0) {
    try {
      tokenRequest = await prepareTokenRequest(request, matched.pricing.token);
    } catch {
      return jsonError(
        400,
        "invalid_token_request",
        "Token-priced calls require a JSON body up to 1 MiB, one completion, and a positive output limit up to 1000000 tokens",
        requestId,
      );
    }
  }
  const cost = tokenRequest?.hold ?? matched.pricing.cost;
  const freeTier = matched.pricing.freeTier;
  const reservationId = requestId;

  const freeTierScope = {
    clerkOrgId: verified.orgId,
    projectId: published.projectId,
    method: matched.method,
    pathTemplate: matched.pathTemplate,
  };

  let usedFree = false;
  let unmetered = false;
  let freeTierUsedBefore: number | undefined;
  let keyBudget: KeyBudgetSnapshot | undefined;
  if (cost === 0) {
    const authorization = await wallet.authorizeKey(
      verified.keyId,
      verified.orgId,
      (deps.now ?? Date.now)(),
    );
    if (authorization.status === "rejected") {
      if (authorization.reason === "wallet_unavailable") {
        return jsonError(
          503,
          "wallet_unavailable",
          "Wallet temporarily unavailable",
          requestId,
        );
      }
      if (authorization.reason === "insufficient_credits") {
        return paymentRequiredResponse(requestId, "Insufficient credits", {
          reason: "insufficient_credits",
          available: authorization.available ?? 0,
          cost: 0,
        });
      }

      if (authorization.reason === "organization_archived") {
        return jsonError(
          403,
          "organization_archived",
          "Organization is archived",
          requestId,
        );
      }
      if (authorization.reason === "key_untracked") {
        return jsonError(
          403,
          "key_untracked",
          "API key is not managed by Zevium",
          requestId,
        );
      }
      return jsonError(403, "key_disabled", "API key is disabled", requestId);
    }
    keyBudget = authorization.keyBudget;
    unmetered = true;
  } else if (freeTier !== undefined && freeTier > 0) {
    const freeResult = await wallet.consumeFreeTier(freeTier, {
      keyId: verified.keyId,
      ...freeTierScope,
      nowMs: (deps.now ?? Date.now)(),
    });
    if (
      freeResult.status === "rejected" &&
      freeResult.reason === "wallet_unavailable"
    ) {
      return jsonError(
        503,
        "wallet_unavailable",
        "Wallet temporarily unavailable",
        requestId,
      );
    }
    if (freeResult.status === "consumed") {
      usedFree = true;
      freeTierUsedBefore = freeResult.usedBefore;
      keyBudget = freeResult.keyBudget;
    } else if (freeResult.status === "exhausted") {
      freeTierUsedBefore = freeResult.used;
    } else if (
      freeResult.status === "rejected" &&
      freeResult.reason === "insufficient_credits"
    ) {
      return paymentRequiredResponse(requestId, "Insufficient credits", {
        reason: "insufficient_credits",
        available: freeResult.available ?? 0,
        cost: 0,
      });
    } else if (
      freeResult.status === "rejected" &&
      (freeResult.reason === "key_disabled" ||
        freeResult.reason === "key_untracked" ||
        freeResult.reason === "organization_archived")
    ) {
      return jsonError(
        403,
        freeResult.reason,

        freeResult.reason === "organization_archived"
          ? "Organization is archived"
          : freeResult.reason === "key_untracked"
            ? "API key is not managed by Zevium"
            : "API key is disabled",
        requestId,
      );
    }
  }

  if (!usedFree && !unmetered) {
    const reserve = await wallet.reserve(reservationId, cost, {
      tokenPricing: matched.pricing.token !== undefined,
      keyId: verified.keyId,
      clerkOrgId: verified.orgId,
    });
    if (
      reserve.status === "rejected" &&
      reserve.reason === "wallet_unavailable"
    ) {
      return jsonError(
        503,
        "wallet_unavailable",
        "Wallet temporarily unavailable",
        requestId,
      );
    }
    if (
      reserve.status === "rejected" &&
      (reserve.reason === "in_flight_budget_exhausted" ||
        reserve.reason === "weight_exceeds_budget")
    ) {
      const response = paymentRequiredResponse(
        requestId,
        reserve.reason === "in_flight_budget_exhausted"
          ? "Wait for active calls to finish"
          : "Reduce the prompt or output limit, or add credits",
        {
          reason: reserve.reason,
          metadata: { reason: reserve.reason },
          cost,
        },
      );
      if (reserve.reason === "in_flight_budget_exhausted")
        response.headers.set("Retry-After", "5");
      return response;
    }
    if (reserve.status === "insufficient") {
      // Zero/insufficient balance blocks the call — same payment shape
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
        reserve.reason === "key_cap_exceeded" ||
        reserve.reason === "organization_archived")
    ) {
      return jsonError(
        reserve.reason === "key_cap_exceeded" ? 402 : 403,
        reserve.reason,

        reserve.reason === "key_disabled"
          ? "API key is disabled"
          : reserve.reason === "key_untracked"
            ? "API key is not managed by Zevium"
            : reserve.reason === "organization_archived"
              ? "Organization is archived"
              : "Monthly spending limit reached for this key",
        requestId,
      );
    }
    if (reserve.status !== "reserved" && reserve.status !== "duplicate") {
      return jsonError(
        500,
        "reserve_failed",
        "Could not reserve credits. Try again.",
        requestId,
      );
    }
    keyBudget = reserve.keyBudget;
  }

  if (keyBudget === undefined) {
    return jsonError(
      500,
      "pricing_identity_failed",
      "Could not authorize credits for this call. Try again.",
      requestId,
    );
  }
  const immutableUsageIdentity = {
    admissionProof,
    specVersionId: published.specVersionId,
    specVersion: published.version,
    operationId,
    keyFamilyId: keyBudget.keyFamilyId,
    listedCostCredits: cost,
    ...(freeTier === undefined ? {} : { freeTierLimit: freeTier }),
    ...(freeTierUsedBefore === undefined ? {} : { freeTierUsedBefore }),
    pricingDecision: usedFree
      ? ("free_tier" as const)
      : cost === 0
        ? ("zero_price" as const)
        : matched.pricing.token
          ? ("token_usage" as const)
          : ("listed_price" as const),
    ...(keyBudget.monthlyCapCredits === undefined
      ? {}
      : { monthlyCapCredits: keyBudget.monthlyCapCredits }),
    budgetPeriod: keyBudget.period,
    budgetUsedBefore: keyBudget.usedBefore,
    budgetReservedBefore: keyBudget.reservedBefore,
    budgetReservationCredits: keyBudget.reservationCredits,
  };

  return {
    requestId,
    started,
    route,
    verified,
    published,
    matched,
    upstreamUrl,
    tokenRequest,
    cost,
    reservationId,
    wallet,
    freeTierScope,
    usedFree,
    unmetered,
    keyBudget,
    immutableUsageIdentity,
    releaseChallenge,
    gatewayRelease,
  };
}
export type Admission = Exclude<Awaited<ReturnType<typeof admit>>, Response>;
