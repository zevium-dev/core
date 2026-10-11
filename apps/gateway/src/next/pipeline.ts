import { InternalHttpCatalogueSearch } from "../catalogue-search";
import { nextOAuth } from "./oauth";
import type { AdmissionInput } from "./wallet";
import { z } from "zod";
import { sha256Hex, matchOperation, joinUpstreamUrl } from "@zevium/shared";
import {
  snapshot,
  keyPolicy,
  catalogueListing,
} from "@zevium/shared/edge/snapshots";
import {
  decryptHeaders,
  readRing,
  type RoutePayload,
} from "@zevium/shared/edge/replication";
import { readSnapshot, type NextEnv } from "./snapshots";
import {
  extractApiKey,
  type VerifiedKey,
  type VerifyOutcome,
} from "../key-verifier";
import {
  SpecSourceUnavailableError,
  getParsedSpec,
  type PublishedSpec,
} from "../spec-source";
import { paymentRequiredResponse } from "../payment-required";
import { jsonError } from "../errors";
import { assertSafeUpstreamTarget } from "../upstream-safety";
import { forward } from "../forward";
import { filterResponseHeaders } from "../headers";
import { applyDeprecationHeaders } from "../deprecation";
import type { WorkerDeps } from "../index";
import type { GatewayRoute, PipelineEnv } from "../pipeline";
const keyPayload = z.object({
  clerkOrgId: z.string(),
  keys: z.array(keyPolicy),
});
async function keyEvidence(
  env: NextEnv,
  secret: string,
  trusted?: VerifiedKey,
) {
  const hash = trusted ? `key:${trusted.keyId}` : await sha256Hex(secret),
    projection = await readSnapshot(env, "keys", hash);
  if (!projection) throw new SpecSourceUnavailableError();
  if (projection.payload === null) return null;
  const payload = keyPayload.parse(projection.payload),
    key = payload.keys.find((k) =>
      trusted
        ? k.keyId === trusted.keyId && payload.clerkOrgId === trusted.orgId
        : k.secretSha256 === hash,
    );
  if (!key) return null;
  const org = await readSnapshot(env, "org", payload.clerkOrgId);
  if (!org) throw new SpecSourceUnavailableError();
  if (
    !org.payload ||
    z.object({ archived: z.boolean() }).parse(org.payload).archived
  )
    return null;
  return {
    key,
    orgId: payload.clerkOrgId,
    validUntil: Math.min(projection.expiresAt, org.expiresAt),
  };
}
async function routeEvidence(
  env: NextEnv,
  handle: string,
  slug: string,
  consumer = "",
) {
  const p = await readSnapshot(
    env,
    "route",
    JSON.stringify([handle, slug, consumer]),
  );
  if (!p) throw new SpecSourceUnavailableError();
  if (p.payload === null) return null;
  // Parse the frozen payload through its discriminated signed-snapshot contract.
  const value = snapshot.parse({ schemaVersion: 2, ...p, kind: "route" });
  if (value.kind !== "route") throw new SpecSourceUnavailableError();
  const org = await readSnapshot(env, "org", value.payload.clerkOrgId);
  if (!org) throw new SpecSourceUnavailableError();
  if (
    !org.payload ||
    z.object({ archived: z.boolean() }).parse(org.payload).archived
  )
    return null;
  return {
    payload: value.payload,
    validUntil: Math.min(p.expiresAt, org.expiresAt),
  };
}
function published(p: RoutePayload): PublishedSpec {
  const { upstreamHeaders: _encrypted, ...rest } = p;
  return rest;
}
export function nextDeps(env: NextEnv): WorkerDeps {
  const verifyWithStatus = async (secret: string): Promise<VerifyOutcome> => {
    try {
      const e = await keyEvidence(env, secret);
      return e
        ? {
            status: "ok",
            key: { orgId: e.orgId, keyId: e.key.keyId, scopes: e.key.scopes },
          }
        : { status: "invalid" };
    } catch {
      return { status: "unavailable" };
    }
  };
  const publicSpecSource = {
    getPublishedSpec: async (handle: string, slug: string) => {
      const e = await routeEvidence(env, handle, slug);
      if (!e || e.payload.visibility !== "public" || e.payload.retired)
        return null;
      return published(e.payload);
    },
  };
  return {
    searchSource:
      env.NEXT_CONVEX_SITE_URL && env.GATEWAY_INTERNAL_SECRET
        ? new InternalHttpCatalogueSearch({
            siteUrl: env.NEXT_CONVEX_SITE_URL,
            internalSecret: env.GATEWAY_INTERNAL_SECRET,
          })
        : undefined,
    oauthVerifier: nextOAuth(env),
    keyVerifier: {
      verifyWithStatus,
      verify: async (secret) => {
        const r = await verifyWithStatus(secret);
        return r.status === "ok" ? r.key : null;
      },
    },
    specSource: publicSpecSource,
    publicSpecSource,
    catalogueSource: {
      listPublic: async (args) => {
        const p = await readSnapshot(env, "catalogue", "public");
        if (!p) throw new SpecSourceUnavailableError();
        const items = z
          .object({ items: z.array(catalogueListing) })
          .parse(p.payload).items;
        const visible = [];
        for (const item of items) {
          if (args?.tag && !item.tags.includes(args.tag)) continue;
          if (
            args?.search &&
            !`${item.name} ${item.description ?? ""}`
              .toLowerCase()
              .includes(args.search.toLowerCase())
          )
            continue;
          visible.push({ ...item, description: item.description });
        }
        return { items: visible, nextCursor: null };
      },
    },
    nextExecute: (
      request,
      pipelineEnv,
      ctx,
      route,
      prepare,
      authenticatedKey,
    ) =>
      execute(
        request,
        { ...pipelineEnv, ...env },
        ctx,
        route,
        prepare,
        authenticatedKey,
      ),
  };
}
async function execute(
  request: Request,
  env: NextEnv & PipelineEnv,
  _ctx: ExecutionContext,
  route: GatewayRoute,
  prepareResponse?: (response: Response) => Promise<Response>,
  authenticatedKey?: VerifiedKey,
) {
  const id = crypto.randomUUID(),
    started = Date.now(),
    secret = extractApiKey(request);
  const payment = (
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) =>
    paymentRequiredResponse(
      id,
      message,
      {
        reason,
        ...extra,
        ...(reason === "key_cap_exceeded" ? { error: reason } : {}),
      },
      env.APP_ORIGIN,
    );
  if (!secret && !authenticatedKey)
    return payment("missing_api_key", "API key required");
  let evidence: Awaited<ReturnType<typeof keyEvidence>>,
    routeInfo: Awaited<ReturnType<typeof routeEvidence>>;
  try {
    evidence = await keyEvidence(env, secret ?? "", authenticatedKey);
    if (!evidence) return payment("invalid_api_key", "Invalid API key");
    if (
      evidence.key.lifecycle === "disabled" ||
      (evidence.key.expiresAt !== undefined &&
        evidence.key.expiresAt <= Date.now()) ||
      (evidence.key.graceUntil !== undefined &&
        evidence.key.graceUntil <= Date.now())
    )
      return jsonError(403, "key_disabled", "API key is disabled", id);
    routeInfo = await routeEvidence(
      env,
      route.publisherHandle,
      route.projectSlug,
      evidence.orgId,
    );
  } catch {
    return jsonError(
      503,
      "gateway_unavailable",
      "Gateway configuration is temporarily unavailable",
      id,
    );
  }
  if (!routeInfo)
    return jsonError(404, "project_not_found", "API not found", id);
  const p = routeInfo.payload;
  if (p.visibility !== "public" && p.clerkOrgId !== evidence.orgId)
    return jsonError(404, "project_not_found", "API not found", id);
  if (
    p.retired ||
    p.retiredAt !== undefined ||
    (p.sunsetAt !== undefined && started >= p.sunsetAt)
  ) {
    const response = jsonError(
      410,
      "sunset_reached",
      "This API has reached its published sunset",
      id,
    );
    applyDeprecationHeaders(response.headers, p, route);
    return response;
  }
  if (!p.admission.allowed)
    return jsonError(
      403,
      "consumer_not_entitled",
      "This API no longer accepts new consumers",
      id,
    );
  let matched: ReturnType<typeof matchOperation>, upstreamUrl: URL;
  try {
    matched = matchOperation(
      getParsedSpec(p),
      request.method,
      route.remainderPath,
    );
    if (!matched || matched.pricing.token)
      return jsonError(
        404,
        "route_not_found",
        "No available priced endpoint matches this method and path",
        id,
      );
    if (!matched.upstreamBaseUrl)
      return jsonError(
        404,
        "no_upstream",
        "Publisher has not configured an upstream URL",
        id,
      );
  } catch {
    return jsonError(
      422,
      "invalid_spec",
      "Published endpoint is unavailable",
      id,
    );
  }
  try {
    upstreamUrl = new URL(
      joinUpstreamUrl(matched.upstreamBaseUrl, route.remainderPath),
    );
    assertSafeUpstreamTarget(upstreamUrl);
    upstreamUrl.search = new URL(request.url).search;
  } catch {
    return jsonError(
      422,
      "unsafe_upstream",
      "This API's upstream URL is not permitted",
      id,
    );
  }
  if (!env.NEXT_WALLET)
    return jsonError(
      503,
      "wallet_unavailable",
      "Wallet temporarily unavailable",
      id,
    );
  const wallet = env.NEXT_WALLET.get(
    env.NEXT_WALLET.idFromName(
      JSON.stringify([env.NEXT_DEPLOYMENT_ID, evidence.orgId]),
    ),
  );
  const pub = published(p);
  try {
    if (p.upstreamHeaders)
      pub.upstreamHeaders = await decryptHeaders(
        p.upstreamHeaders,
        [env.NEXT_DEPLOYMENT_ID, p.projectId, p.credentialRevision],
        readRing(env.NEXT_TRANSPORT_KEYS),
      );
  } catch {
    return jsonError(
      503,
      "gateway_unavailable",
      "Gateway configuration is temporarily unavailable",
      id,
    );
  }
  const result = await wallet.admit(
    {
      protocolVersion: 2,
      deploymentId: env.NEXT_DEPLOYMENT_ID!,
      consumerClerkOrgId: evidence.orgId,
      publisherOrganizationId: p.organizationId,
      projectId: p.projectId,
      specVersionId: p.specVersionId,
      specVersion: p.version,
      specDigest: p.specDigest,
      operationId: matched.operationId,
      endpoint: matched.pathTemplate,
      method: matched.method.toUpperCase() as AdmissionInput["method"],
      reservationId: id,
      settleRefId: `settle:${id}`,
      admittedAt: started,
      listedCostCredits: matched.pricing.cost,
      keyId: evidence.key.keyId,
      ...(matched.pricing.freeTier !== undefined
        ? { freeTierLimit: matched.pricing.freeTier }
        : {}),
    },
    evidence.key,
    Math.min(evidence.validUntil, routeInfo.validUntil),
  );
  if (!result.ok) {
    const response =
      result.status === 402
        ? payment(
            result.reason,
            result.reason === "key_cap_exceeded"
              ? "Monthly spending limit reached for this key"
              : "Insufficient credits",
            {
              cost: result.cost,
              ...(result.available !== undefined
                ? { available: result.available }
                : {}),
            },
          )
        : jsonError(
            result.status,
            result.reason,
            result.status === 429
              ? "Too many requests for this API key. Try again shortly."
              : result.status === 403
                ? "API key is disabled"
                : "Wallet temporarily unavailable",
            id,
          );
    if (result.retryAfter)
      response.headers.set("Retry-After", String(result.retryAfter));
    return response;
  }
  const forwarded = await forward(
    request,
    {
      published: pub,
      verified: {
        orgId: evidence.orgId,
        keyId: evidence.key.keyId,
        scopes: evidence.key.scopes,
      },
      upstreamUrl,
    },
    undefined,
    prepareResponse,
  );
  const status = "response" in forwarded ? forwarded.response.status : 502;
  // Durable local final precedes response; network usage delivery is alarm-owned.
  await wallet.finalize(id, status, Date.now() - started);
  if (!("response" in forwarded))
    return jsonError(
      502,
      forwarded.timedOut ? "upstream_timeout" : "upstream_error",
      "Upstream request failed",
      id,
    );
  const headers = filterResponseHeaders(forwarded.response.headers);
  headers.set("x-zevium-request-id", id);
  headers.set("x-zevium-cost", String(result.admission.heldCredits));
  if (result.admission.pricingDecision === "free_tier")
    headers.set("x-zevium-free-tier", "1");
  applyDeprecationHeaders(headers, p, route);
  return new Response(forwarded.response.body, { status, headers });
}
