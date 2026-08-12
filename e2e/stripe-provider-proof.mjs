#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import Stripe from "stripe";
import {
  MAX_PROVIDER_OBJECTS,
  STRIPE_API_VERSION,
  assertExclusiveEndpointTopology,
  assertAcceptanceReport,
  assertAppPathEvidence,
  assertCompensationEvidence,
  assertDeploymentBinding,
  assertLedgerEvidence,
  assertNoCompetingEventDestinations,
  assertPendingCanaryEvent,
  assertUsageEvidence,
  invariant,
  normalizeRunRef,
  requireTestStripeKey,
} from "./stripe-provider-proof-lib.mjs";

const execFileAsync = promisify(execFile);
const statePath =
  process.env.PAYMENT_DRILL_STATE ??
  new URL("./artifacts/payment-drill-state.json", import.meta.url).pathname;
const reportPath =
  process.env.STRIPE_PROVIDER_REPORT ??
  new URL("./provider-artifacts/stripe-provider-proof.json", import.meta.url)
    .pathname;
const acceptanceReportPath =
  process.env.PAYMENT_PROOF_REPORT ??
  new URL("./artifacts/payment-proof-report.json", import.meta.url).pathname;
const refundEventType = "charge.refunded";
const canaryPurpose = "zevium_payment_drill_canary";

function stripeClient(keyName) {
  return new Stripe(requireTestStripeKey(process.env, keyName), {
    apiVersion: STRIPE_API_VERSION,
  });
}

function checkoutStripe() {
  return stripeClient("STRIPE_CHECKOUT_PROOF_KEY");
}

function webhookStripe() {
  return stripeClient("STRIPE_WEBHOOK_ADMIN_KEY");
}

function connectStripe() {
  return stripeClient("STRIPE_CONNECT_PROOF_KEY");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readStateOrNull() {
  try {
    return await readJson(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSafeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function updateState(patch) {
  const state = (await readStateOrNull()) ?? {
    schemaVersion: 3,
    startedAt: new Date().toISOString(),
  };
  const next = { ...state, schemaVersion: 3, ...patch };
  await writeSafeJson(statePath, next);
  return next;
}

function objectId(value) {
  return typeof value === "string" ? value : value?.id;
}

function assertTestObject(value, label) {
  invariant(value?.livemode === false, `${label} must be a test-mode object`);
}

function requireId(value, pattern, label) {
  invariant(pattern.test(value ?? ""), `${label} is missing or invalid`);
  return value;
}

function requireWebhookUrl(value, pathname, label) {
  invariant(value, `${label} is required`);
  const url = new URL(value);
  invariant(url.protocol === "https:", `${label} must use HTTPS`);
  invariant(
    url.username === "" &&
      url.password === "" &&
      url.pathname === pathname &&
      url.search === "" &&
      url.hash === "",
    `${label} must be an exact credential-free ${pathname} URL`,
  );
  return url;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectBounded(iterable, label) {
  const values = [];
  for await (const value of iterable) {
    values.push(value);
    invariant(
      values.length <= MAX_PROVIDER_OBJECTS,
      `${label} exceeded ${MAX_PROVIDER_OBJECTS} objects`,
    );
  }
  return values;
}

async function convexRunFunction(functionName, args = {}) {
  invariant(process.env.CONVEX_DEPLOY_KEY, "CONVEX_DEPLOY_KEY is required");
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "exec",
      "convex",
      "run",
      "--codegen",
      "disable",
      functionName,
      JSON.stringify(args),
    ],
    { env: process.env, maxBuffer: 2_000_000, timeout: 30_000 },
  );
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Convex ${functionName} did not return JSON`);
  }
}

async function convexInline(source, label) {
  invariant(process.env.CONVEX_DEPLOY_KEY, "CONVEX_DEPLOY_KEY is required");
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "convex", "run", "--codegen", "disable", "--inline-query", source],
    { env: process.env, maxBuffer: 2_000_000, timeout: 30_000 },
  );
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Convex ${label} did not return JSON`);
  }
}

function requiredDeploymentExpectation() {
  const githubSha = requireId(
    process.env.GITHUB_SHA?.trim(),
    /^[0-9a-f]{40}$/,
    "GITHUB_SHA",
  );
  const mode = process.env.ZEVIUM_DEPLOYMENT_MODE?.trim();
  invariant(mode === "staging", "ZEVIUM_DEPLOYMENT_MODE must be staging");
  const deploymentIds = {
    web: requireId(
      process.env.ZEVIUM_WEB_DEPLOYMENT_ID?.trim(),
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/,
      "Web deployment id",
    ),
    gateway: requireId(
      process.env.ZEVIUM_GATEWAY_DEPLOYMENT_ID?.trim(),
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/,
      "Gateway deployment id",
    ),
    convex: requireId(
      process.env.ZEVIUM_CONVEX_DEPLOYMENT_ID?.trim(),
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/,
      "Convex deployment id",
    ),
  };
  const maxAgeSeconds = Number(
    process.env.ZEVIUM_DEPLOYMENT_MAX_AGE_SECONDS ?? "86400",
  );
  invariant(
    Number.isSafeInteger(maxAgeSeconds) &&
      maxAgeSeconds >= 60 &&
      maxAgeSeconds <= 7 * 24 * 60 * 60,
    "Deployment freshness window must be 60 seconds to 7 days",
  );
  return {
    githubSha,
    mode,
    deploymentIds,
    maxAgeMs: maxAgeSeconds * 1_000,
  };
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.status === 200, `${label} returned ${response.status}`);
  invariant(
    response.headers.get("content-type")?.includes("application/json"),
    `${label} did not return JSON`,
  );
  return await response.json();
}

async function verifyDeployments() {
  const expected = requiredDeploymentExpectation();
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  const existing = await readStateOrNull();
  invariant(
    existing === null ||
      (existing.runRef === runRef && existing.githubSha === expected.githubSha),
    "Payment proof state belongs to another run or Git SHA",
  );
  if (existing === null) {
    await updateState({ runRef, githubSha: expected.githubSha });
  }
  const baseUrl = new URL(process.env.E2E_BASE_URL);
  const gatewayUrl = new URL(process.env.GATEWAY_URL);
  invariant(
    baseUrl.protocol === "https:" && gatewayUrl.protocol === "https:",
    "Staging deployment proof requires HTTPS",
  );
  const [web, gatewayHealth, convex] = await Promise.all([
    fetchJson(
      new URL("/.well-known/zevium-deployment.json", baseUrl),
      "Web deployment manifest",
    ),
    fetchJson(new URL("/health", gatewayUrl), "Gateway deployment manifest"),
    convexRunFunction("deploymentProof:get"),
  ]);
  invariant(gatewayHealth?.ok === true, "Gateway health is not ready");
  const proof = {
    manifests: [web, gatewayHealth.deployment, convex],
    verifiedAt: new Date().toISOString(),
  };
  assertDeploymentBinding(proof, expected);
  await updateState({
    runRef,
    githubSha: expected.githubSha,
    deploymentProof: proof,
  });
  process.stdout.write("exact fresh deployment revisions verified\n");
}

async function findEvent({
  stripe,
  type,
  objectId: expectedId,
  created,
  match = undefined,
}) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const events = await collectBounded(
      stripe.events.list({
        type,
        created: { gte: Math.max(0, created - 120) },
        limit: 100,
      }),
      `${type} event search`,
    );
    const candidates = events.filter(
      (event) =>
        event.data?.object?.id === expectedId &&
        (match === undefined || match(event)),
    );
    invariant(candidates.length <= 1, `${type} event correlation is ambiguous`);
    if (candidates[0] !== undefined) {
      assertTestObject(candidates[0], `${type} event`);
      return candidates[0];
    }
    await sleep(1_000);
  }
  throw new Error(`${type} event did not appear for ${expectedId}`);
}

async function retrieveCheckout(stripe, sessionId) {
  requireId(sessionId, /^cs_test_[A-Za-z0-9]+$/, "Checkout Session id");
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent.latest_charge"],
  });
  assertTestObject(session, "Checkout Session");
  return session;
}

async function checkoutSnapshot() {
  const stripe = checkoutStripe();
  const state = await readJson(statePath);
  const session = await retrieveCheckout(stripe, state.checkoutSessionId);
  invariant(session.mode === "payment", "Checkout Session mode changed");
  invariant(session.status === "complete", "Checkout Session is not complete");
  invariant(session.payment_status === "paid", "Checkout payment is not paid");
  invariant(
    session.amount_total === 1_000,
    "Checkout amount must be exactly $10",
  );
  invariant(session.currency === "usd", "Checkout currency must be USD");
  invariant(session.metadata?.packId === "pack_10", "Checkout pack changed");
  invariant(
    typeof session.metadata?.checkoutIntentId === "string" &&
      session.metadata.checkoutIntentId.length > 0,
    "Checkout intent correlation is missing",
  );
  invariant(
    typeof session.metadata?.clerkOrgId === "string" &&
      session.metadata.clerkOrgId.length > 0,
    "Checkout organization correlation is missing",
  );
  const intent = session.payment_intent;
  invariant(
    typeof intent === "object" && intent !== null,
    "PaymentIntent missing",
  );
  assertTestObject(intent, "PaymentIntent");
  invariant(intent.status === "succeeded", "PaymentIntent did not succeed");
  invariant(intent.amount_received === 1_000, "PaymentIntent amount changed");
  const chargeId = requireId(
    objectId(intent.latest_charge),
    /^ch_[A-Za-z0-9]+$/,
    "Checkout charge id",
  );
  const expectedOrigin = new URL(process.env.E2E_BASE_URL).origin;
  invariant(
    new URL(session.success_url).origin === expectedOrigin,
    "Checkout success origin changed",
  );
  invariant(
    new URL(session.cancel_url).origin === expectedOrigin,
    "Checkout cancel origin changed",
  );
  const event = await findEvent({
    stripe,
    type: "checkout.session.completed",
    objectId: session.id,
    created: session.created,
  });
  await updateState({
    checkoutIntentId: session.metadata.checkoutIntentId,
    clerkOrgId: session.metadata.clerkOrgId,
    paymentIntentId: intent.id,
    chargeId,
    grantEventId: event.id,
    checkoutVerifiedAt: new Date().toISOString(),
  });
  process.stdout.write("checkout provider facts verified\n");
}

async function resolvePaidCharge(stripe, state, { allowUnpaid = false } = {}) {
  const session = await retrieveCheckout(stripe, state.checkoutSessionId);
  if (session.payment_status !== "paid") {
    if (allowUnpaid) return { session, intent: null, charge: null };
    throw new Error("Checkout has no paid charge");
  }
  const intent = session.payment_intent;
  invariant(
    typeof intent === "object" && intent !== null,
    "PaymentIntent missing",
  );
  const chargeId = requireId(
    objectId(intent.latest_charge),
    /^ch_[A-Za-z0-9]+$/,
    "Checkout charge id",
  );
  const charge = await stripe.charges.retrieve(chargeId);
  assertTestObject(charge, "Charge");
  return { session, intent, charge };
}

async function createRefund(kind) {
  const stripe = checkoutStripe();
  const state = await readJson(statePath);
  const { session, intent, charge } = await resolvePaidCharge(stripe, state);
  const remaining = charge.amount - charge.amount_refunded;
  invariant(remaining >= 0, "Charge refund exceeds charge amount");
  if (remaining === 0) {
    process.stdout.write("checkout already fully refunded\n");
    return;
  }
  if (kind === "partial") {
    invariant(
      charge.amount_refunded === 0 && remaining >= 250,
      "Partial refund requires an untouched Checkout charge",
    );
  }
  const amount = kind === "partial" ? 250 : remaining;
  const cumulativeAmount =
    kind === "partial" ? charge.amount_refunded + amount : charge.amount;
  const refundParams = {
    payment_intent: intent.id,
    metadata: {
      zevium_drill: "true",
      phase: kind,
      checkoutSessionId: session.id,
    },
  };
  if (kind === "partial") refundParams.amount = amount;
  const refund = await stripe.refunds.create(refundParams, {
    idempotencyKey: `zevium-drill:${session.id}:${kind === "partial" ? "partial-250" : "full-remaining"}`,
  });
  assertTestObject(refund, "Refund");
  invariant(refund.status === "succeeded", `${kind} refund did not succeed`);
  invariant(refund.amount === amount, `${kind} refund amount changed`);
  const event = await findEvent({
    stripe,
    type: refundEventType,
    objectId: charge.id,
    created: charge.created,
    match: (candidate) =>
      candidate.data.object.amount_refunded === cumulativeAmount,
  });
  const eventField =
    kind === "partial" ? "partialRefundEventId" : "fullRefundEventId";
  await updateState({
    paymentIntentId: intent.id,
    chargeId: charge.id,
    refunds: [
      ...(state.refunds ?? []).filter((entry) => entry.kind !== kind),
      { kind, id: refund.id, amount: refund.amount, status: refund.status },
    ],
    [eventField]: event.id,
    latestRefundEventId: event.id,
  });
  process.stdout.write(`${kind} refund provider facts verified\n`);
}

async function listWebhookEndpoints(stripe) {
  return collectBounded(
    stripe.webhookEndpoints.list({ limit: 100 }),
    "webhook endpoint list",
  );
}

async function assertNoV2RefundDestinations(stripe) {
  const destinations = await collectBounded(
    stripe.v2.core.eventDestinations.list({ limit: 100 }),
    "v2 event destination list",
  );
  return assertNoCompetingEventDestinations(destinations, refundEventType);
}

function canonicalEndpoint(endpoints) {
  const id = requireId(
    process.env.STRIPE_WEBHOOK_ENDPOINT_ID?.trim(),
    /^we_[A-Za-z0-9]+$/,
    "Canonical webhook endpoint id",
  );
  const expectedUrl = requireWebhookUrl(
    process.env.STRIPE_WEBHOOK_ENDPOINT_URL?.trim(),
    "/stripe-webhook",
    "STRIPE_WEBHOOK_ENDPOINT_URL",
  ).href;
  const matches = endpoints.filter((endpoint) => endpoint.id === id);
  invariant(matches.length === 1, "Canonical webhook endpoint was not found");
  const endpoint = matches[0];
  assertTestObject(endpoint, "Canonical webhook endpoint");
  invariant(endpoint.status === "enabled", "Canonical webhook is disabled");
  invariant(endpoint.connect === false, "Canonical webhook is Connect-scoped");
  invariant(endpoint.url === expectedUrl, "Canonical webhook URL drifted");
  return endpoint;
}

async function deleteCanaries(
  stripe,
  runRef,
  { exceptId } = { exceptId: undefined },
) {
  const endpoints = await listWebhookEndpoints(stripe);
  const stale = endpoints.filter(
    (endpoint) =>
      endpoint.id !== exceptId &&
      endpoint.metadata?.purpose === canaryPurpose &&
      endpoint.metadata?.runRef === runRef &&
      endpoint.id !== process.env.STRIPE_WEBHOOK_ENDPOINT_ID,
  );
  for (const endpoint of stale) {
    assertTestObject(endpoint, "Disposable webhook canary");
    await stripe.webhookEndpoints.del(endpoint.id);
  }
  return stale.map((endpoint) => endpoint.id);
}

async function beginWebhookCanary() {
  const stripe = webhookStripe();
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  let endpoints = await listWebhookEndpoints(stripe);
  const matchingCanaries = endpoints.filter(
    (endpoint) =>
      endpoint.metadata?.purpose === canaryPurpose &&
      endpoint.metadata?.runRef === runRef,
  );
  invariant(
    matchingCanaries.length <= 1,
    "Webhook canary correlation is ambiguous",
  );
  await deleteCanaries(stripe, runRef, {
    exceptId: matchingCanaries[0]?.id,
  });
  endpoints = await listWebhookEndpoints(stripe);
  const canonical = canonicalEndpoint(endpoints);
  const canaryTarget = requireWebhookUrl(
    process.env.STRIPE_WEBHOOK_CANARY_URL?.trim(),
    "/stripe-proof-intentional-404",
    "STRIPE_WEBHOOK_CANARY_URL",
  );
  invariant(
    canaryTarget.origin === new URL(canonical.url).origin,
    "Webhook canary must share canonical Convex origin",
  );
  const canaryUrl = canaryTarget.href;
  const response = await fetch(canaryUrl, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  invariant(
    response.status === 404,
    `Webhook canary URL returned ${response.status}`,
  );
  const canary =
    matchingCanaries[0] ??
    (await stripe.webhookEndpoints.create({
      url: canaryUrl,
      enabled_events: [refundEventType],
      api_version: STRIPE_API_VERSION,
      connect: false,
      description: `Disposable Zevium payment drill ${runRef}`,
      metadata: { purpose: canaryPurpose, runRef },
    }));
  assertTestObject(canary, "Disposable webhook canary");
  invariant(canary.url === canaryUrl, "Webhook canary URL changed");
  invariant(
    canary.status === "enabled" &&
      canary.enabled_events.length === 1 &&
      canary.enabled_events[0] === refundEventType,
    "Webhook canary subscription changed",
  );
  endpoints = await listWebhookEndpoints(stripe);
  canonicalEndpoint(endpoints);
  await assertNoV2RefundDestinations(stripe);
  assertExclusiveEndpointTopology({
    endpoints,
    canonicalEndpointId: canonical.id,
    canaryEndpointId: canary.id,
    eventType: refundEventType,
  });
  await updateState({
    webhookCanary: {
      endpointId: canary.id,
      canonicalEndpointId: canonical.id,
      createdAt: new Date().toISOString(),
      runRef,
    },
  });
  process.stdout.write("disposable webhook failure canary installed\n");
}

async function cleanupWebhookCanary() {
  const stripe = webhookStripe();
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  const deleted = await deleteCanaries(stripe, runRef);
  const endpoints = await listWebhookEndpoints(stripe);
  const canonical = canonicalEndpoint(endpoints);
  const state = await readStateOrNull();
  const expectedCanonicalId = state?.webhookCanary?.canonicalEndpointId;
  invariant(
    expectedCanonicalId === undefined || canonical.id === expectedCanonicalId,
    "Canonical webhook identity changed during cleanup",
  );
  await updateState({
    webhookCanaryCleanup: {
      deletedEndpointIds: [
        ...new Set([
          ...(state?.webhookCanaryCleanup?.deletedEndpointIds ?? []),
          ...deleted,
        ]),
      ],
      canonicalEndpointId: canonical.id,
      canonicalUnchanged:
        state?.webhookCanaryCleanup?.canonicalUnchanged !== false &&
        (expectedCanonicalId === undefined ||
          canonical.id === expectedCanonicalId),
      verifiedAt: new Date().toISOString(),
    },
  });
  process.stdout.write(
    "disposable webhook canaries removed; canonical unchanged\n",
  );
}

async function proveCanaryAndReplay() {
  const stripe = webhookStripe();
  const state = await readJson(statePath);
  const eventId = requireId(
    state.partialRefundEventId,
    /^evt_[A-Za-z0-9]+$/,
    "Partial refund event id",
  );
  const canaryId = requireId(
    state.webhookCanary?.endpointId,
    /^we_[A-Za-z0-9]+$/,
    "Webhook canary id",
  );
  invariant(
    state.ledgerSnapshots?.partial?.event?.stripeEventId === eventId &&
      state.ledgerSnapshots.partial.event.status === "processed" &&
      state.ledgerSnapshots.partial.event.deliveries === 1,
    "Canonical webhook does not have one exact processed receipt",
  );
  const endpoints = await listWebhookEndpoints(stripe);
  const canonical = canonicalEndpoint(endpoints);
  invariant(
    canonical.id === state.webhookCanary.canonicalEndpointId,
    "Canonical webhook identity changed during drill",
  );
  assertExclusiveEndpointTopology({
    endpoints,
    canonicalEndpointId: canonical.id,
    canaryEndpointId: canaryId,
    eventType: refundEventType,
  });
  const competingV2Destinations = await assertNoV2RefundDestinations(stripe);
  let event;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    event = await stripe.events.retrieve(eventId);
    assertTestObject(event, "Partial refund event");
    if (event.pending_webhooks === 1) break;
    await sleep(1_000);
  }
  assertPendingCanaryEvent(event, 1);
  await stripe.webhookEndpoints.del(canaryId);
  const postDelete = await listWebhookEndpoints(stripe);
  canonicalEndpoint(postDelete);
  invariant(
    !postDelete.some((endpoint) => endpoint.id === canaryId),
    "Disposable webhook canary was not deleted",
  );
  const canaryDeletedAt = new Date().toISOString();
  await stripe.rawRequest(
    "POST",
    `/v1/events/${encodeURIComponent(eventId)}/retry`,
    { webhook_endpoint: canonical.id },
    { idempotencyKey: `zevium-canonical-replay:${eventId}:${canonical.id}` },
  );
  const canonicalReplayRequestedAt = new Date().toISOString();
  await updateState({
    failedWebhookDelivery: {
      eventId,
      canaryEndpointId: canaryId,
      canonicalEndpointId: canonical.id,
      exactPendingDeliveries: 1,
      canonicalReceiptDeliveries: 1,
      exclusiveV1SubscriberIds: [canonical.id, canaryId],
      competingV2SubscriberCount: competingV2Destinations.length,
      canaryDeletedAt,
      canonicalReplayRequestedAt,
    },
    webhookCanaryCleanup: {
      deletedEndpointIds: [canaryId],
      canonicalEndpointId: canonical.id,
      canonicalUnchanged: true,
      verifiedAt: new Date().toISOString(),
    },
  });
  process.stdout.write(
    "failed canary delivery proved; canonical replay requested\n",
  );
}

async function convexEvidence(checkoutSessionId, eventId) {
  invariant(process.env.CONVEX_DEPLOY_KEY, "CONVEX_DEPLOY_KEY is required");
  const checkoutLiteral = JSON.stringify(checkoutSessionId);
  const eventLiteral = eventId === null ? "null" : JSON.stringify(eventId);
  const source = `
const payments = await ctx.db.query("payments").withIndex("by_checkout_session", q => q.eq("stripeCheckoutSessionId", ${checkoutLiteral})).take(2);
if (payments.length > 1) throw new Error("duplicate payment projection");
const payment = payments[0] ?? null;
if (payment === null) return { payment: null, wallet: null, event: null, reversalJournalCredits: 0, disputeCount: 0, reconciliation: null, exposures: [], clawbacks: [], earnings: [], publishers: [] };
const wallets = await ctx.db.query("wallets").withIndex("by_organization", q => q.eq("organizationId", payment.organizationId)).take(2);
if (wallets.length > 1) throw new Error("duplicate organization wallet");
const wallet = wallets[0] ?? null;
const events = ${eventLiteral} === null ? [] : await ctx.db.query("paymentEvents").withIndex("by_stripe_event", q => q.eq("stripeEventId", ${eventLiteral})).take(2);
if (events.length > 1) throw new Error("duplicate Stripe event receipt");
const reversals = await ctx.db.query("walletFundingReversals").withIndex("by_payment_created", q => q.eq("paymentId", payment._id)).take(501);
if (reversals.length > 500) throw new Error("reversal journal proof exceeded 500 rows");
const disputes = await ctx.db.query("paymentDisputes").withIndex("by_payment", q => q.eq("paymentId", payment._id)).take(101);
if (disputes.length > 100) throw new Error("dispute proof exceeded 100 rows");
const jobs = await ctx.db.query("publisherReconciliationJobs").withIndex("by_payment", q => q.eq("paymentId", payment._id)).take(2);
if (jobs.length > 1) throw new Error("duplicate publisher reconciliation job");
const exposures = await ctx.db.query("paymentExposures").withIndex("by_payment_created", q => q.eq("paymentId", payment._id)).order("asc").take(501);
if (exposures.length > 500) throw new Error("payment exposure proof exceeded 500 rows");
const clawbackRows = await ctx.db.query("publisherClawbacks").withIndex("by_payment", q => q.eq("paymentId", payment._id)).order("asc").take(501);
if (clawbackRows.length > 500) throw new Error("publisher clawback proof exceeded 500 rows");
const earningIds = [...new Set(clawbackRows.map(row => String(row.earningId)))];
const earnings = [];
for (const earningId of earningIds) {
  const normalized = ctx.db.normalizeId("publisherEarnings", earningId);
  if (normalized === null) throw new Error("publisher earning id is invalid");
  const earning = await ctx.db.get(normalized);
  if (earning === null) throw new Error("publisher earning is missing");
  const allClawbacks = await ctx.db.query("publisherClawbacks").withIndex("by_earning", q => q.eq("earningId", earning._id)).take(501);
  if (allClawbacks.length > 500) throw new Error("earning clawback proof exceeded 500 rows");
  const activeClawbackGrossCredits = allClawbacks.reduce((sum, row) => sum + row.grossCredits - (row.restoredGrossCredits ?? 0), 0);
  const activeClawbackAtoms = allClawbacks.reduce((sum, row) => sum + row.amountAtoms - (row.restoredAtoms ?? 0), 0);
  earnings.push({
    id: String(earning._id),
    publisherOrganizationId: String(earning.publisherOrganizationId),
    consumerOrganizationId: String(earning.consumerOrganizationId),
    projectId: earning.projectId === undefined ? null : String(earning.projectId),
    usageSettlementRefId: earning.usageSettlementRefId,
    grossCredits: earning.grossCredits,
    platformFeeAtoms: earning.platformFeeAtoms,
    publisherNetAtoms: earning.publisherNetAtoms,
    clawedBackGrossCredits: earning.clawedBackGrossCredits,
    clawedBackAtoms: earning.clawedBackAtoms,
    releasedAtoms: earning.releasedAtoms,
    status: earning.status,
    activeClawbackGrossCredits,
    activeClawbackAtoms
  });
}
const clawbacks = [];
for (const row of clawbackRows) {
  const journalRef = row.sourceRef + ":clawback:" + String(row._id);
  const journals = await ctx.db.query("publisherSettlementEntries").withIndex("by_ref", q => q.eq("refId", journalRef)).take(2);
  if (journals.length > 1) throw new Error("duplicate publisher clawback journal");
  const journal = journals[0];
  clawbacks.push({
    id: String(row._id),
    paymentId: String(row.paymentId),
    consumerOrganizationId: String(row.consumerOrganizationId),
    publisherOrganizationId: String(row.publisherOrganizationId),
    earningId: String(row.earningId),
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    grossCredits: row.grossCredits,
    amountAtoms: row.amountAtoms,
    restoredGrossCredits: row.restoredGrossCredits ?? 0,
    restoredAtoms: row.restoredAtoms ?? 0,
    state: row.state ?? "active",
    journal: journal === undefined ? null : {
      kind: journal.kind,
      refId: journal.refId,
      publisherOrganizationId: String(journal.publisherOrganizationId),
      sequence: journal.sequence,
      availableDeltaAtoms: journal.availableDeltaAtoms,
      allocatedDeltaAtoms: journal.allocatedDeltaAtoms,
      paidDeltaAtoms: journal.paidDeltaAtoms,
      paymentId: journal.paymentId === undefined ? null : String(journal.paymentId),
      earningId: journal.earningId === undefined ? null : String(journal.earningId)
    }
  });
}
const publisherIds = [...new Set(clawbackRows.map(row => String(row.publisherOrganizationId)))];
const publishers = [];
for (const publisherId of publisherIds) {
  const normalized = ctx.db.normalizeId("organizations", publisherId);
  if (normalized === null) throw new Error("publisher organization id is invalid");
  const balances = await ctx.db.query("publisherBalances").withIndex("by_publisher", q => q.eq("publisherOrganizationId", normalized)).take(2);
  if (balances.length !== 1) throw new Error("publisher balance is missing or duplicated");
  const balance = balances[0];
  const entries = await ctx.db.query("publisherSettlementEntries").withIndex("by_publisher", q => q.eq("publisherOrganizationId", normalized)).order("asc").take(501);
  if (entries.length > 500) throw new Error("publisher settlement proof exceeded 500 rows");
  const allEarnings = await ctx.db.query("publisherEarnings").withIndex("by_publisher", q => q.eq("publisherOrganizationId", normalized)).take(501);
  if (allEarnings.length > 500) throw new Error("publisher earning proof exceeded 500 rows");
  const allTransfers = await ctx.db.query("publisherTransfers").withIndex("by_publisher", q => q.eq("publisherOrganizationId", normalized)).take(501);
  if (allTransfers.length > 500) throw new Error("publisher transfer proof exceeded 500 rows");
  publishers.push({
    organizationId: publisherId,
    balance: {
      availableAtoms: balance.availableAtoms,
      allocatedAtoms: balance.allocatedAtoms,
      paidAtoms: balance.paidAtoms,
      pendingRiskAtoms: balance.pendingRiskAtoms ?? 0,
      reversedAtoms: balance.reversedAtoms ?? 0,
      failedAtoms: balance.failedAtoms ?? 0,
      sequence: balance.sequence
    },
    journalSums: {
      availableAtoms: entries.reduce((sum, row) => sum + row.availableDeltaAtoms, 0),
      allocatedAtoms: entries.reduce((sum, row) => sum + row.allocatedDeltaAtoms, 0),
      paidAtoms: entries.reduce((sum, row) => sum + row.paidDeltaAtoms, 0),
      entryCount: entries.length,
      lastSequence: entries.at(-1)?.sequence ?? 0
    },
    derivedAggregates: {
      pendingRiskAtoms: allEarnings.filter(row => row.status === "pending_risk").reduce((sum, row) => sum + row.publisherNetAtoms - row.clawedBackAtoms, 0),
      reversedAtoms: allEarnings.reduce((sum, row) => sum + row.clawedBackAtoms, 0),
      failedAtoms: allTransfers.filter(row => row.status === "failed").reduce((sum, row) => sum + row.amountAtoms, 0)
    }
  });
}
return {
  payment: {
    id: String(payment._id),
    organizationId: String(payment.organizationId),
    checkoutSessionId: payment.stripeCheckoutSessionId,
    stripeChargeId: payment.stripeChargeId ?? null,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    grantedCredits: payment.grantedCredits,
    refundedAmount: payment.refundedAmount,
    refundedCredits: payment.refundedCredits,
    reversedCredits: payment.reversedCredits,
    walletReversedCredits: payment.walletReversedCredits ?? 0,
    publisherClawbackTargetCredits: payment.publisherClawbackTargetCredits ?? 0
  },
  wallet: wallet === null ? null : { balance: wallet.balance, sequence: wallet.sequence },
  event: events[0] === undefined ? null : {
    stripeEventId: events[0].stripeEventId,
    eventType: events[0].eventType,
    objectId: events[0].objectId,
    status: events[0].status,
    deliveries: events[0].deliveries,
    attempts: events[0].attempts
  },
  reversalJournalCredits: reversals.reduce((sum, row) => sum + row.grossCredits, 0),
  disputeCount: disputes.length,
  reconciliation: jobs[0] === undefined ? null : {
    paymentId: String(jobs[0].paymentId),
    consumerOrganizationId: String(jobs[0].consumerOrganizationId),
    status: jobs[0].status,
    revision: jobs[0].revision,
    processedChunks: jobs[0].processedChunks,
    lastError: jobs[0].lastError ?? null
  },
  exposures: exposures.map(row => ({
    id: String(row._id),
    paymentId: String(row.paymentId),
    organizationId: String(row.organizationId),
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    sourceAmount: row.sourceAmount,
    sourceAmountExact: row.sourceAmountExact ?? false,
    requestedCredits: row.requestedCredits,
    effectiveCredits: row.effectiveCredits,
    walletCredits: row.walletCredits,
    publisherCredits: row.publisherCredits,
    appliedPublisherCredits: row.appliedPublisherCredits,
    active: row.active
  })),
  clawbacks,
  earnings,
  publishers
};`;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "convex", "run", "--codegen", "disable", "--inline-query", source],
    { env: process.env, maxBuffer: 2_000_000, timeout: 30_000 },
  );
  try {
    return {
      ...JSON.parse(stdout.trim()),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    throw new Error("Convex ledger proof did not return JSON");
  }
}

async function waitLedger(
  label,
  eventId,
  expectedRefunded,
  minDeliveries,
  baselineLabel,
  maxDeliveries = Number.POSITIVE_INFINITY,
) {
  requireId(eventId, /^evt_[A-Za-z0-9]+$/, "Stripe event id");
  const state = await readJson(statePath);
  const baseline = baselineLabel
    ? state.ledgerSnapshots?.[baselineLabel]
    : null;
  if (baselineLabel)
    invariant(baseline, `Ledger baseline ${baselineLabel} is missing`);
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const evidence = await convexEvidence(state.checkoutSessionId, eventId);
      assertLedgerEvidence(evidence, {
        expectedRefundedCredits: expectedRefunded,
        eventId,
        minDeliveries,
        maxDeliveries,
        expectedEventType:
          expectedRefunded === 0
            ? "checkout.session.completed"
            : refundEventType,
        expectedObjectId:
          expectedRefunded === 0 ? state.checkoutSessionId : state.chargeId,
        baseline,
      });
      await updateState({
        ledgerSnapshots: {
          ...(state.ledgerSnapshots ?? {}),
          [label]: evidence,
        },
      });
      process.stdout.write(`ledger ${label} verified\n`);
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(
    `Ledger ${label} did not converge: ${lastError?.message ?? "unknown"}`,
  );
}

async function recordUsageProof(path) {
  const proof = await readJson(path);
  invariant(proof?.schemaVersion === 1, "Gateway usage proof schema changed");
  invariant(
    typeof proof.projectSlug === "string" && proof.projectSlug.length > 0,
    "Gateway usage proof project is missing",
  );
  invariant(
    Array.isArray(proof.calls) && proof.calls.length === 3,
    "Gateway usage proof must contain UI, direct, and browser calls",
  );
  for (const call of proof.calls) {
    invariant(
      /^[A-Za-z0-9_-]{8,}$/.test(call.requestId ?? "") &&
        Number.isSafeInteger(call.cost) &&
        call.cost > 0 &&
        call.status === 200 &&
        call.method === "GET" &&
        call.endpoint === "/get",
      "Gateway usage proof call is invalid",
    );
  }
  invariant(
    new Set(proof.calls.map((call) => call.requestId)).size ===
      proof.calls.length,
    "Gateway usage proof reused a request id",
  );
  await updateState({ usageProof: proof });
  process.stdout.write("gateway paid-call identities recorded\n");
}

async function convexUsageEvidence(state) {
  invariant(process.env.CONVEX_DEPLOY_KEY, "CONVEX_DEPLOY_KEY is required");
  const checkoutLiteral = JSON.stringify(state.checkoutSessionId);
  const refsLiteral = JSON.stringify(
    state.usageProof.calls.map((call) => `settle:${call.requestId}`),
  );
  const baselineSequence = state.ledgerSnapshots.grant.wallet.sequence;
  const projectSlugLiteral = JSON.stringify(state.usageProof.projectSlug);
  const source = `
const payments = await ctx.db.query("payments").withIndex("by_checkout_session", q => q.eq("stripeCheckoutSessionId", ${checkoutLiteral})).take(2);
if (payments.length !== 1) throw new Error("payment projection is missing or duplicated");
const payment = payments[0];
const wallets = await ctx.db.query("wallets").withIndex("by_organization", q => q.eq("organizationId", payment.organizationId)).take(2);
if (wallets.length !== 1) throw new Error("organization wallet is missing or duplicated");
const wallet = wallets[0];
const calls = [];
for (const refId of ${refsLiteral}) {
  const entries = await ctx.db.query("walletEntries").withIndex("by_ref", q => q.eq("refId", refId)).take(2);
  if (entries.length !== 1 || entries[0].usageEventId === undefined) throw new Error("exact usage wallet entry is missing or duplicated");
  const usage = await ctx.db.get(entries[0].usageEventId);
  if (usage === null) throw new Error("usage event is missing");
  const project = await ctx.db.get(usage.projectId);
  if (project === null) throw new Error("usage project is missing");
  calls.push({
    entry: { refId: entries[0].refId, kind: entries[0].kind, amount: entries[0].amount, sequence: entries[0].sequence },
    usage: { settleRefId: usage.settleRefId, credits: usage.credits, status: usage.status, method: usage.method, endpoint: usage.endpoint, organizationId: String(usage.organizationId) },
    project: {
      id: String(project._id),
      slug: project.slug,
      publisherOrganizationId: String(project.organizationId)
    }
  });
}
const intervening = await ctx.db.query("walletEntries").withIndex("by_wallet_sequence", q => q.eq("walletId", wallet._id).gt("sequence", ${baselineSequence})).order("asc").take(501);
if (intervening.length > 500) throw new Error("usage ledger proof exceeded 500 rows");
return {
  projectSlug: ${projectSlugLiteral},
  payment: {
    organizationId: String(payment.organizationId),
    status: payment.status,
    refundedCredits: payment.refundedCredits,
    reversedCredits: payment.reversedCredits,
    walletReversedCredits: payment.walletReversedCredits ?? 0,
    publisherClawbackTargetCredits: payment.publisherClawbackTargetCredits ?? 0
  },
  wallet: { balance: wallet.balance, sequence: wallet.sequence },
  calls,
  interveningEntries: intervening.map(entry => ({ refId: entry.refId, kind: entry.kind, amount: entry.amount, sequence: entry.sequence }))
};`;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "convex", "run", "--codegen", "disable", "--inline-query", source],
    { env: process.env, maxBuffer: 2_000_000, timeout: 30_000 },
  );
  try {
    return {
      ...JSON.parse(stdout.trim()),
      capturedAt: new Date().toISOString(),
    };
  } catch {
    throw new Error("Convex usage proof did not return JSON");
  }
}

async function waitUsage() {
  const state = await readJson(statePath);
  const baseline = state.ledgerSnapshots?.grant;
  invariant(baseline, "Grant ledger baseline is missing");
  invariant(state.usageProof, "Gateway usage proof is missing");
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const evidence = await convexUsageEvidence(state);
      assertUsageEvidence(evidence, state.usageProof.calls, baseline);
      await updateState({
        ledgerSnapshots: {
          ...state.ledgerSnapshots,
          usage: evidence,
        },
      });
      process.stdout.write("exact paid gateway usage ledger verified\n");
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(
    `Gateway usage ledger did not converge: ${lastError?.message ?? "unknown"}`,
  );
}

async function printStateField(path) {
  const state = await readJson(statePath);
  let value = state;
  for (const segment of path.split(".")) value = value?.[segment];
  invariant(
    typeof value === "string" || typeof value === "number",
    `State field ${path} is missing`,
  );
  process.stdout.write(`${value}\n`);
}

async function recordBalance(field, rawValue) {
  const allowed = new Set(["walletBeforeGrant", "walletAfterGrant"]);
  invariant(allowed.has(field), "Unknown wallet proof field");
  const value = Number(rawValue);
  invariant(
    Number.isSafeInteger(value),
    "Wallet proof value must be an integer",
  );
  await updateState({ [field]: value });
}

async function recordProviderId(field, value) {
  const patterns = {
    checkoutSessionId: /^cs_test_[A-Za-z0-9]+$/,
    terminalCheckoutSessionId: /^cs_test_[A-Za-z0-9]+$/,
  };
  invariant(patterns[field]?.test(value ?? ""), "Invalid provider proof id");
  await updateState({ [field]: value });
}

async function expireCheckout() {
  const stripe = checkoutStripe();
  const state = await readJson(statePath);
  let session = await retrieveCheckout(stripe, state.terminalCheckoutSessionId);
  invariant(session.payment_status === "unpaid", "Terminal checkout was paid");
  if (session.status === "open")
    session = await stripe.checkout.sessions.expire(session.id);
  invariant(session.status === "expired", "Checkout Session did not expire");
  const event = await findEvent({
    stripe,
    type: "checkout.session.expired",
    objectId: session.id,
    created: session.created,
  });
  await updateState({
    terminalCheckout: {
      checkoutSessionId: session.id,
      eventId: event.id,
      providerStatus: session.status,
    },
  });
  process.stdout.write("Checkout expiry provider facts verified\n");
}

async function recordPaymentRecoveryBaseline() {
  const state = await readStateOrNull();
  if (state === null || !state.checkoutSessionId) {
    process.stdout.write("no payment state needs a recovery baseline\n");
    return;
  }
  const before = await convexEvidence(state.checkoutSessionId, null);
  invariant(
    before.payment !== null && before.wallet !== null,
    "Paid checkout is absent from Convex",
  );
  await updateState({
    ledgerSnapshots: {
      ...(state.ledgerSnapshots ?? {}),
      recoveryBaseline: before,
    },
  });
  process.stdout.write("payment recovery ledger baseline recorded\n");
}

async function recoverPaymentProvider() {
  await cleanupWebhookCanary();
  const state = await readStateOrNull();
  if (state === null || !state.checkoutSessionId) {
    process.stdout.write("no payment provider state to recover\n");
    return;
  }
  const stripe = checkoutStripe();
  const resolved = await resolvePaidCharge(stripe, state, {
    allowUnpaid: true,
  });
  if (resolved.intent === null) {
    let session = resolved.session;
    if (session.status === "open")
      session = await stripe.checkout.sessions.expire(session.id);
    invariant(
      session.status === "expired",
      "Unpaid recovery checkout did not expire",
    );
    process.stdout.write("unpaid checkout expired during recovery\n");
    return;
  }
  const charge = resolved.charge;
  if (charge.amount_refunded < charge.amount) await createRefund("remaining");
  const current = await stripe.charges.retrieve(charge.id);
  invariant(
    current.amount_refunded === current.amount,
    "Recovery refund is incomplete",
  );
  const refunds = await collectBounded(
    stripe.refunds.list({ charge: charge.id, limit: 100 }),
    "checkout recovery refunds",
  );
  const succeededRefunds = refunds.filter(
    (refund) => refund.status === "succeeded",
  );
  invariant(
    succeededRefunds.reduce((sum, refund) => sum + refund.amount, 0) ===
      current.amount,
    "Recovery refunds do not conserve the full charge",
  );
  const event = await findEvent({
    stripe,
    type: refundEventType,
    objectId: charge.id,
    created: charge.created,
    match: (candidate) =>
      candidate.data.object.amount_refunded === charge.amount,
  });
  await updateState({
    fullRefundEventId: event.id,
    refunds: succeededRefunds
      .map((refund) => ({
        kind:
          refund.amount === 250
            ? "partial"
            : refund.amount === 750
              ? "remaining"
              : "recovery",
        id: refund.id,
        amount: refund.amount,
        status: refund.status,
      }))
      .sort((left, right) => left.amount - right.amount),
  });
  process.stdout.write("paid checkout provider state fully recovered\n");
}

async function recoverPaymentLedger() {
  const state = await readStateOrNull();
  if (state === null || !state.checkoutSessionId) {
    process.stdout.write("no payment ledger state to recover\n");
    return;
  }
  invariant(
    state.ledgerSnapshots?.recoveryBaseline,
    "Payment recovery baseline is missing",
  );
  const eventId = requireId(
    state.fullRefundEventId,
    /^evt_[A-Za-z0-9]+$/,
    "Full refund recovery event id",
  );
  await waitLedger("recovery", eventId, 100_000, 1, "recoveryBaseline");
  process.stdout.write("paid checkout and Convex ledger fully recovered\n");
}

async function convexAppSnapshot(
  clerkOrgId,
  transferId = null,
  eventId = null,
) {
  const clerkLiteral = JSON.stringify(clerkOrgId);
  const transferLiteral =
    transferId === null ? "null" : JSON.stringify(transferId);
  const eventLiteral = eventId === null ? "null" : JSON.stringify(eventId);
  const source = `
const organizations = await ctx.db.query("organizations").withIndex("by_clerk_org", q => q.eq("clerkOrgId", ${clerkLiteral})).take(2);
if (organizations.length !== 1) throw new Error("active organization is missing or duplicated");
const organization = organizations[0];
const profiles = await ctx.db.query("organizationPayments").withIndex("by_organization", q => q.eq("organizationId", organization._id)).take(2);
if (profiles.length !== 1) throw new Error("organization payment profile is missing or duplicated");
const profile = profiles[0];
const balances = await ctx.db.query("publisherBalances").withIndex("by_publisher", q => q.eq("publisherOrganizationId", organization._id)).take(2);
if (balances.length !== 1) throw new Error("publisher balance is missing or duplicated");
const balance = balances[0];
const transfers = await ctx.db.query("publisherTransfers").withIndex("by_publisher", q => q.eq("publisherOrganizationId", organization._id)).order("asc").take(501);
if (transfers.length > 500) throw new Error("publisher transfer proof exceeded 500 rows");
let transfer = null;
let settlementEntries = [];
if (${transferLiteral} !== null) {
  const normalized = ctx.db.normalizeId("publisherTransfers", ${transferLiteral});
  if (normalized === null) throw new Error("publisher transfer id is invalid");
  transfer = await ctx.db.get(normalized);
  if (transfer === null) throw new Error("publisher transfer is missing");
  settlementEntries = await ctx.db.query("publisherSettlementEntries").withIndex("by_transfer_sequence", q => q.eq("transferId", transfer._id)).order("asc").take(11);
  if (settlementEntries.length > 10) throw new Error("transfer settlement proof exceeded 10 rows");
}
const allEntries = await ctx.db.query("publisherSettlementEntries").withIndex("by_publisher", q => q.eq("publisherOrganizationId", organization._id)).order("asc").take(501);
if (allEntries.length > 500) throw new Error("publisher journal proof exceeded 500 rows");
const events = ${eventLiteral} === null ? [] : await ctx.db.query("paymentEvents").withIndex("by_stripe_event", q => q.eq("stripeEventId", ${eventLiteral})).take(2);
if (events.length > 1) throw new Error("transfer webhook receipt is duplicated");
return {
  organization: { id: String(organization._id), clerkOrgId: organization.clerkOrgId },
  profile: {
    id: String(profile._id),
    organizationId: String(profile.organizationId),
    stripeConnectedAccountId: profile.stripeConnectedAccountId ?? null,
    payoutsEnabled: profile.payoutsEnabled,
    disabledReason: profile.disabledReason ?? null
  },
  balance: {
    availableAtoms: balance.availableAtoms,
    allocatedAtoms: balance.allocatedAtoms,
    paidAtoms: balance.paidAtoms,
    pendingRiskAtoms: balance.pendingRiskAtoms ?? 0,
    reversedAtoms: balance.reversedAtoms ?? 0,
    failedAtoms: balance.failedAtoms ?? 0,
    sequence: balance.sequence
  },
  journalSums: {
    availableAtoms: allEntries.reduce((sum, row) => sum + row.availableDeltaAtoms, 0),
    allocatedAtoms: allEntries.reduce((sum, row) => sum + row.allocatedDeltaAtoms, 0),
    paidAtoms: allEntries.reduce((sum, row) => sum + row.paidDeltaAtoms, 0),
    entryCount: allEntries.length,
    lastSequence: allEntries.at(-1)?.sequence ?? 0
  },
  transferIds: transfers.map(row => String(row._id)),
  openTransferCount: transfers.filter(row => row.status === "created" || row.status === "pending" || row.status === "failed").length,
  transfer: transfer === null ? null : {
    id: String(transfer._id),
    profileId: String(profile._id),
    publisherOrganizationId: String(transfer.publisherOrganizationId),
    stripeConnectedAccountId: transfer.stripeConnectedAccountId,
    amount: transfer.amount,
    amountAtoms: transfer.amountAtoms,
    remainderAtoms: transfer.remainderAtoms,
    currency: transfer.currency,
    stripeTransferId: transfer.stripeTransferId ?? null,
    reversedAmount: transfer.reversedAmount ?? 0,
    correlationNonce: transfer.correlationNonce ?? null,
    correlationHmac: transfer.correlationHmac ?? null,
    platformAccountId: transfer.platformAccountId ?? null,
    status: transfer.status
  },
  settlementEntries: settlementEntries.map(row => ({
    kind: row.kind,
    availableDeltaAtoms: row.availableDeltaAtoms,
    allocatedDeltaAtoms: row.allocatedDeltaAtoms,
    paidDeltaAtoms: row.paidDeltaAtoms,
    sequence: row.sequence,
    refId: row.refId
  })),
  event: events[0] === undefined ? null : {
    stripeEventId: events[0].stripeEventId,
    eventType: events[0].eventType,
    objectId: events[0].objectId,
    status: events[0].status,
    deliveries: events[0].deliveries,
    attempts: events[0].attempts
  }
};`;
  return await convexInline(source, "app-path proof");
}

function expectedAppIdentity() {
  return {
    clerkOrgId: requireId(
      process.env.E2E_PUBLISHER_CLERK_ORG_ID?.trim(),
      /^org_[A-Za-z0-9]+$/,
      "Publisher Clerk organization id",
    ),
    connectedAccountId: requireId(
      process.env.STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID?.trim(),
      /^acct_[A-Za-z0-9]+$/,
      "Settlement account id",
    ),
    platformAccountId: requireId(
      process.env.STRIPE_CONNECT_PLATFORM_ACCOUNT_ID?.trim(),
      /^acct_[A-Za-z0-9]+$/,
      "Platform account id",
    ),
  };
}

async function recordAppBaseline() {
  const expected = expectedAppIdentity();
  const state = await readJson(statePath);
  invariant(
    state.clerkOrgId === expected.clerkOrgId,
    "Checkout and publisher journey use different active organizations",
  );
  const snapshot = await convexAppSnapshot(expected.clerkOrgId);
  invariant(
    snapshot.profile.stripeConnectedAccountId === expected.connectedAccountId &&
      snapshot.profile.payoutsEnabled === true &&
      snapshot.profile.disabledReason === null,
    "Exact publisher profile is not transfer-enabled",
  );
  invariant(
    snapshot.openTransferCount === 0,
    "Publisher has unfinished transfer state",
  );
  invariant(
    snapshot.balance.availableAtoms >= 1_000_000_000 &&
      snapshot.balance.allocatedAtoms === 0,
    "Publisher fixture lacks clean $10 available earnings",
  );
  invariant(
    snapshot.journalSums.availableAtoms === snapshot.balance.availableAtoms &&
      snapshot.journalSums.allocatedAtoms === snapshot.balance.allocatedAtoms &&
      snapshot.journalSums.paidAtoms === snapshot.balance.paidAtoms &&
      snapshot.journalSums.entryCount === snapshot.balance.sequence &&
      snapshot.journalSums.lastSequence === snapshot.balance.sequence,
    "Publisher baseline journal does not materialize to balance",
  );
  await updateState({
    appPath: {
      ...(state.appPath ?? {}),
      baseline: snapshot,
    },
  });
  process.stdout.write("exact publisher app baseline recorded\n");
}

async function recordAppOnboarding(urlValue, activeClerkOrgId) {
  const state = await readJson(statePath);
  const baseline = state.appPath?.baseline;
  invariant(baseline, "App baseline is missing");
  invariant(
    activeClerkOrgId === baseline.organization.clerkOrgId,
    "Onboarding UI used wrong active organization",
  );
  const url = new URL(urlValue);
  invariant(
    url.protocol === "https:" &&
      (url.hostname === "connect.stripe.com" ||
        url.hostname.endsWith(".connect.stripe.com")) &&
      url.username === "" &&
      url.password === "",
    "App onboarding did not open Stripe-hosted Connect",
  );
  await updateState({
    appPath: {
      ...state.appPath,
      onboarding: {
        authenticated: true,
        activeClerkOrgId,
        action: "payouts.startOnboarding",
        apiSurface: "v2.core.accountLinks.create",
        profileId: baseline.profile.id,
        connectedAccountId: baseline.profile.stripeConnectedAccountId,
        linkOrigin: url.origin,
        linkHash: createHash("sha256").update(url.href).digest("hex"),
        observedAt: new Date().toISOString(),
      },
    },
  });
  process.stdout.write("authenticated v2 onboarding app redirect recorded\n");
}

async function verifyAppOnboardingProvider() {
  const stripe = connectStripe();
  const state = await readJson(statePath);
  const onboarding = state.appPath?.onboarding;
  invariant(onboarding, "Onboarding app observation is missing");
  const account = await stripe.v2.core.accounts.retrieve(
    onboarding.connectedAccountId,
    { include: ["configuration.recipient", "defaults", "requirements"] },
  );
  assertConnectAccount(account, "App onboarding account");
  invariant(!account.closed, "App onboarding account is closed");
  invariant(
    account.dashboard === "express",
    "App onboarding account dashboard changed",
  );
  const capabilities =
    account.configuration?.recipient?.capabilities?.stripe_balance;
  invariant(
    capabilities?.stripe_transfers?.status === "active" &&
      capabilities?.payouts?.status === "active",
    "App onboarding account is not transfer/payout active",
  );
  await updateState({
    appPath: {
      ...state.appPath,
      onboarding: {
        ...onboarding,
        provider: {
          accountId: account.id,
          dashboard: account.dashboard,
          transferCapability: capabilities.stripe_transfers.status,
          payoutCapability: capabilities.payouts.status,
          verifiedAt: new Date().toISOString(),
        },
      },
    },
  });
  process.stdout.write("app onboarding provider account verified\n");
}

async function recordAppTransferUi(activeClerkOrgId) {
  const state = await readJson(statePath);
  const baseline = state.appPath?.baseline;
  invariant(baseline, "App baseline is missing");
  invariant(
    activeClerkOrgId === baseline.organization.clerkOrgId,
    "Transfer UI used wrong active organization",
  );
  await updateState({
    appPath: {
      ...state.appPath,
      transfer: {
        ...(state.appPath?.transfer ?? {}),
        ui: {
          authenticated: true,
          activeClerkOrgId,
          action: "payouts.initiatePublisherTransfer",
          observedAt: new Date().toISOString(),
        },
      },
    },
  });
  process.stdout.write("authenticated publisher transfer UI action recorded\n");
}

async function waitAppTransferLedger() {
  const state = await readJson(statePath);
  const baseline = state.appPath?.baseline;
  invariant(
    baseline && state.appPath?.transfer?.ui,
    "Transfer app baseline/UI is missing",
  );
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const snapshot = await convexAppSnapshot(
        baseline.organization.clerkOrgId,
      );
      const fresh = snapshot.transferIds.filter(
        (id) => !baseline.transferIds.includes(id),
      );
      invariant(fresh.length === 1, "App transfer correlation is ambiguous");
      const exact = await convexAppSnapshot(
        baseline.organization.clerkOrgId,
        fresh[0],
      );
      invariant(
        exact.transfer.status === "succeeded" &&
          exact.transfer.stripeTransferId !== null &&
          exact.transfer.profileId === baseline.profile.id,
        "App transfer has not reached succeeded state",
      );
      const expected = expectedAppIdentity();
      invariant(
        exact.transfer.stripeConnectedAccountId ===
          expected.connectedAccountId &&
          exact.transfer.platformAccountId === expected.platformAccountId,
        "App transfer account/platform correlation changed",
      );
      invariant(
        exact.settlementEntries.length === 2 &&
          exact.settlementEntries[0].kind === "transfer_allocation" &&
          exact.settlementEntries[1].kind === "transfer_succeeded",
        "App transfer ledger is incomplete",
      );
      await updateState({
        appPath: {
          ...state.appPath,
          transfer: {
            ...state.appPath.transfer,
            local: exact.transfer,
            settlementEntries: exact.settlementEntries,
          },
        },
      });
      process.stdout.write("exact app transfer ledger verified\n");
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(
    `App transfer ledger did not converge: ${lastError?.message ?? "unknown"}`,
  );
}

async function verifyAppTransferProvider() {
  const stripe = connectStripe();
  const state = await readJson(statePath);
  const local = state.appPath?.transfer?.local;
  invariant(local, "Local app transfer proof is missing");
  const [transfer, platform] = await Promise.all([
    stripe.transfers.retrieve(local.stripeTransferId),
    stripe.accounts.retrieveCurrent(),
  ]);
  assertTestObject(transfer, "App publisher transfer");
  invariant(
    platform.id === local.platformAccountId,
    "Connect proof key belongs to another platform account",
  );
  const provider = {
    id: transfer.id,
    livemode: transfer.livemode,
    amount: transfer.amount,
    amountReversed: transfer.amount_reversed,
    reversed: transfer.reversed,
    currency: transfer.currency,
    destination: objectId(transfer.destination),
    platformAccountId: platform.id,
    metadata: {
      publisherTransferId: transfer.metadata.publisherTransferId ?? null,
      correlationNonce: transfer.metadata.correlationNonce ?? null,
      correlationHmac: transfer.metadata.correlationHmac ?? null,
      platformAccountId: transfer.metadata.platformAccountId ?? null,
    },
    verifiedAt: new Date().toISOString(),
  };
  invariant(
    provider.amount === local.amount &&
      provider.amountReversed === 0 &&
      provider.reversed === false &&
      provider.destination === local.stripeConnectedAccountId &&
      provider.metadata.publisherTransferId === local.id &&
      provider.metadata.correlationNonce === local.correlationNonce &&
      provider.metadata.correlationHmac === local.correlationHmac &&
      provider.metadata.platformAccountId === local.platformAccountId,
    "App transfer provider/HMAC facts diverged",
  );
  const event = await findEvent({
    stripe,
    type: "transfer.created",
    objectId: transfer.id,
    created: transfer.created,
  });
  await updateState({
    appPath: {
      ...state.appPath,
      transfer: {
        ...state.appPath.transfer,
        provider,
        providerEventId: event.id,
      },
    },
  });
  process.stdout.write("exact app transfer provider/HMAC facts verified\n");
}

async function waitAppTransferWebhook() {
  const state = await readJson(statePath);
  const baseline = state.appPath?.baseline;
  const transfer = state.appPath?.transfer;
  invariant(
    baseline &&
      transfer?.local &&
      transfer.provider &&
      transfer.providerEventId,
    "Provider transfer proof is missing",
  );
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const snapshot = await convexAppSnapshot(
        baseline.organization.clerkOrgId,
        transfer.local.id,
        transfer.providerEventId,
      );
      const evidence = {
        ...state.appPath,
        transfer: {
          ...transfer,
          local: snapshot.transfer,
          settlementEntries: snapshot.settlementEntries,
          webhook: snapshot.event,
        },
      };
      assertAppPathEvidence(evidence, expectedAppIdentity());
      await updateState({ appPath: evidence });
      process.stdout.write("exact app transfer webhook correlation verified\n");
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(
    `App transfer webhook did not converge: ${lastError?.message ?? "unknown"}`,
  );
}

async function compensateAppTransfer() {
  const stripe = connectStripe();
  const state = await readJson(statePath);
  const local = state.appPath?.transfer?.local;
  if (!local?.stripeTransferId) {
    process.stdout.write("no app transfer exists to compensate\n");
    return;
  }
  let transfer = await stripe.transfers.retrieve(local.stripeTransferId);
  assertTestObject(transfer, "App transfer compensation");
  invariant(
    transfer.metadata.publisherTransferId === local.id &&
      transfer.metadata.correlationNonce === local.correlationNonce &&
      transfer.metadata.correlationHmac === local.correlationHmac &&
      transfer.metadata.platformAccountId === local.platformAccountId,
    "App transfer compensation correlation changed",
  );
  if (transfer.amount_reversed < transfer.amount) {
    await stripe.transfers.createReversal(
      transfer.id,
      {
        metadata: {
          purpose: "zevium_app_proof_compensation",
          runRef: normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF),
        },
      },
      {
        idempotencyKey: `zevium-app-transfer-compensation:${normalizeRunRef(
          process.env.STRIPE_PROOF_RUN_REF,
        )}:${transfer.id}`,
      },
    );
  }
  transfer = await stripe.transfers.retrieve(transfer.id);
  invariant(
    transfer.reversed === true && transfer.amount_reversed === transfer.amount,
    "App transfer provider compensation is incomplete",
  );
  const event = await findEvent({
    stripe,
    type: "transfer.reversed",
    objectId: transfer.id,
    created: transfer.created,
    match: (candidate) =>
      candidate.data.object.amount_reversed === transfer.amount,
  });
  await updateState({
    appCompensationProvider: {
      id: transfer.id,
      reversed: transfer.reversed,
      amountReversed: transfer.amount_reversed,
      providerEventId: event.id,
      compensatedAt: new Date().toISOString(),
    },
  });
  process.stdout.write("app transfer provider state fully compensated\n");
}

async function waitAppCompensation() {
  const state = await readJson(statePath);
  const baseline = state.appPath?.baseline;
  const local = state.appPath?.transfer?.local;
  const provider = state.appCompensationProvider;
  invariant(
    baseline && local && provider,
    "App compensation prerequisites are missing",
  );
  const full = state.ledgerSnapshots?.full ?? state.ledgerSnapshots?.recovery;
  invariant(full, "Full payment recovery ledger is missing");
  let lastError;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const snapshot = await convexAppSnapshot(
        baseline.organization.clerkOrgId,
        local.id,
        provider.providerEventId,
      );
      const compensation = {
        status: "complete",
        provider: {
          id: provider.id,
          reversed: provider.reversed,
          amountReversed: provider.amountReversed,
        },
        providerEventId: provider.providerEventId,
        local: snapshot.transfer,
        webhook: snapshot.event,
        settlementEntries: snapshot.settlementEntries,
        publisherBalance: snapshot.balance,
        journalSums: snapshot.journalSums,
        payment: {
          status: full.payment.status,
          reconciliationStatus: full.reconciliation?.status ?? null,
        },
        canary: {
          deleted:
            state.webhookCanary === undefined ||
            state.webhookCanaryCleanup?.deletedEndpointIds?.includes(
              state.webhookCanary.endpointId,
            ) === true,
          canonicalUnchanged:
            state.webhookCanaryCleanup?.canonicalUnchanged === true,
          canonicalEndpointId:
            state.webhookCanaryCleanup?.canonicalEndpointId ?? null,
          verifiedAt: state.webhookCanaryCleanup?.verifiedAt ?? null,
        },
        completedAt: new Date().toISOString(),
      };
      assertCompensationEvidence(compensation, state.appPath, full);
      await updateState({ compensation });
      process.stdout.write(
        "app transfer and publisher ledger fully compensated\n",
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(
    `App compensation did not converge: ${lastError?.message ?? "unknown"}`,
  );
}

async function finalizeAcceptanceReport() {
  const state = await readJson(statePath);
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  const finalRefund =
    state.ledgerSnapshots?.full ?? state.ledgerSnapshots?.recovery;
  const refundBaseline =
    state.ledgerSnapshots?.replay ?? state.ledgerSnapshots?.recoveryBaseline;
  invariant(
    finalRefund && refundBaseline,
    "Final refund ledger evidence is missing",
  );
  const report = {
    schemaVersion: 3,
    reportType: "zevium-stripe-acceptance",
    acceptance: true,
    status: "passed",
    run: {
      runRef,
      githubSha: state.githubSha,
      mode: "staging",
      startedAt: state.startedAt,
      completedAt: new Date().toISOString(),
    },
    deployment: state.deploymentProof,
    appPath: state.appPath,
    ledger: {
      usageExpected: state.usageProof?.calls,
      usageBaseline: state.ledgerSnapshots?.grant,
      usage: state.ledgerSnapshots?.usage,
      partial: state.ledgerSnapshots?.partial,
      refundBaseline,
      refund: finalRefund,
    },
    provider: {
      checkoutSessionId: state.checkoutSessionId,
      chargeId: state.chargeId,
      refundIds: state.refunds?.map((refund) => refund.id),
      partialRefundEventId: state.partialRefundEventId,
      refundEventId: finalRefund.event?.stripeEventId,
      checkoutVerifiedAt: state.checkoutVerifiedAt,
      webhookCanary: state.failedWebhookDelivery,
    },
    compensation: state.compensation,
    primitives: {
      acceptanceRole: "supplemental_only",
      requiredForAcceptance: false,
    },
  };
  const deployment = requiredDeploymentExpectation();
  const appPath = expectedAppIdentity();
  assertAcceptanceReport(report, {
    runRef,
    githubSha: deployment.githubSha,
    deployment,
    appPath,
  });
  await writeSafeJson(acceptanceReportPath, report);
  process.stdout.write("Stripe acceptance report v3 passed\n");
}

function assertConnectAccount(account, label) {
  assertTestObject(account, label);
  invariant(
    account.applied_configurations.includes("recipient"),
    `${label} is not recipient`,
  );
  invariant(
    account.defaults?.responsibilities?.fees_collector === "application" &&
      account.defaults?.responsibilities?.losses_collector === "application",
    `${label} fee/loss responsibility changed`,
  );
}

async function listProofAccounts(stripe, runRef) {
  const [open, closed] = await Promise.all([
    collectBounded(
      stripe.v2.core.accounts.list({ closed: false, limit: 100 }),
      "open v2 accounts",
    ),
    collectBounded(
      stripe.v2.core.accounts.list({ closed: true, limit: 100 }),
      "closed v2 accounts",
    ),
  ]);
  return [...open, ...closed].filter(
    (account) =>
      account.metadata?.purpose === "zevium_connect_onboarding_proof" &&
      account.metadata?.runRef === runRef,
  );
}

async function onboardingProof(stripe, runRef, report) {
  const existing = await listProofAccounts(stripe, runRef);
  invariant(
    existing.length <= 1,
    "Onboarding proof account correlation is ambiguous",
  );
  const accountParams = {
    dashboard: "express",
    defaults: {
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application",
      },
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: { stripe_transfers: { requested: true } },
        },
      },
    },
    contact_email: `stripe-proof+${runRef}@example.com`,
    display_name: `Zevium proof ${runRef}`,
    identity: { country: "US" },
    metadata: { purpose: "zevium_connect_onboarding_proof", runRef },
    include: ["configuration.recipient", "defaults", "requirements"],
  };
  const accountOptions = { idempotencyKey: `zevium-onboarding:${runRef}` };
  let account = await stripe.v2.core.accounts.create(
    accountParams,
    accountOptions,
  );
  const accountRetry = await stripe.v2.core.accounts.create(
    accountParams,
    accountOptions,
  );
  invariant(account.id === accountRetry.id, "Onboarding idempotency failed");
  if (existing[0] !== undefined) {
    invariant(
      account.id === existing[0].id,
      "Onboarding idempotency produced another account",
    );
  }
  account = await stripe.v2.core.accounts.retrieve(account.id, {
    include: ["configuration.recipient", "defaults", "requirements"],
  });
  invariant(!account.closed, "Current-attempt onboarding account is closed");
  assertConnectAccount(account, "Onboarding account");
  invariant(
    account.dashboard === "express",
    "Onboarding account is not Express",
  );
  let link;
  try {
    const linkParams = {
      account: account.id,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          collection_options: {
            fields: "eventually_due",
            future_requirements: "include",
          },
          refresh_url: "https://example.com/stripe-proof/refresh",
          return_url: "https://example.com/stripe-proof/return",
        },
      },
    };
    const linkOptions = {
      idempotencyKey: `zevium-onboarding-link:${runRef}`,
    };
    link = await stripe.v2.core.accountLinks.create(linkParams, linkOptions);
    const linkRetry = await stripe.v2.core.accountLinks.create(
      linkParams,
      linkOptions,
    );
    invariant(
      link.url === linkRetry.url && link.account === linkRetry.account,
      "Onboarding-link idempotency failed",
    );
    assertTestObject(link, "Account Link");
    const hostname = new URL(link.url).hostname;
    invariant(
      hostname === "connect.stripe.com" ||
        hostname.endsWith(".connect.stripe.com"),
      "Stripe returned a non-Connect onboarding host",
    );
    account = await stripe.v2.core.accounts.update(account.id, {
      metadata: {
        purpose: "zevium_connect_onboarding_proof",
        runRef,
        hostedLinkCreated: "true",
      },
    });
    report.onboarding = {
      accountId: account.id,
      apiSurface: "v2.core.accountLinks.create",
      hostedLinkCreated: true,
      onboardingCompleted: false,
      closed: false,
      dashboard: account.dashboard,
      appliedConfigurations: account.applied_configurations,
      hostedLinkOrigin: new URL(link.url).origin,
    };
  } finally {
    if (account !== undefined && !account.closed) {
      const closed = await stripe.v2.core.accounts.close(account.id, {
        applied_configurations: account.applied_configurations,
      });
      invariant(
        closed.closed === true,
        "Onboarding proof account did not close",
      );
      report.onboarding = {
        ...report.onboarding,
        accountId: closed.id,
        closed: true,
      };
    }
  }
}

async function proofFundingIntent(stripe, runRef, purpose, amount) {
  const results = await collectBounded(
    stripe.paymentIntents.search({
      query: `metadata['runRef']:'${runRef}' AND metadata['purpose']:'${purpose}'`,
      limit: 100,
    }),
    `${purpose} PaymentIntent search`,
  );
  invariant(
    results.length <= 1,
    `${purpose} PaymentIntent correlation is ambiguous`,
  );
  const params = {
    amount,
    currency: "usd",
    payment_method: "pm_card_bypassPending",
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    expand: ["latest_charge"],
    metadata: { purpose, runRef },
  };
  const options = {
    idempotencyKey: `zevium-provider-funding:${runRef}:${purpose}`,
  };
  let intent = await stripe.paymentIntents.create(params, options);
  const retry = await stripe.paymentIntents.create(params, options);
  invariant(intent.id === retry.id, `${purpose} idempotency failed`);
  if (results[0] !== undefined) {
    invariant(
      intent.id === results[0].id,
      `${purpose} idempotency produced another PaymentIntent`,
    );
  }
  intent = await stripe.paymentIntents.retrieve(intent.id, {
    expand: ["latest_charge"],
  });
  assertTestObject(intent, `${purpose} PaymentIntent`);
  invariant(intent.status === "succeeded", `${purpose} PaymentIntent failed`);
  invariant(
    intent.amount_received === amount,
    `${purpose} funding amount changed`,
  );
  const chargeId = requireId(
    objectId(intent.latest_charge),
    /^ch_[A-Za-z0-9]+$/,
    `${purpose} source charge`,
  );
  return { intent, chargeId };
}

async function proofTransfer(stripe, runRef, settlementId, sourceCharge) {
  const transferGroup = `zevium-proof-${runRef}`;
  const existing = (
    await collectBounded(
      stripe.transfers.list({ transfer_group: transferGroup, limit: 100 }),
      "settlement transfer list",
    )
  ).filter(
    (transfer) => transfer.metadata?.purpose === "zevium_95_5_settlement_proof",
  );
  invariant(
    existing.length <= 1,
    "Settlement transfer correlation is ambiguous",
  );
  const params = {
    amount: 950,
    currency: "usd",
    destination: settlementId,
    source_transaction: sourceCharge,
    transfer_group: transferGroup,
    metadata: {
      purpose: "zevium_95_5_settlement_proof",
      grossUsdCents: "1000",
      publisherUsdCents: "950",
      platformUsdCents: "50",
      runRef,
    },
  };
  const options = { idempotencyKey: `zevium-95-5-transfer:${runRef}` };
  const transfer = await stripe.transfers.create(params, options);
  const retry = await stripe.transfers.create(params, options);
  invariant(transfer.id === retry.id, "Transfer idempotency failed");
  if (existing[0] !== undefined) {
    invariant(
      transfer.id === existing[0].id,
      "Transfer idempotency produced another transfer",
    );
  }
  assertTestObject(transfer, "Settlement transfer");
  invariant(transfer.amount === 950, "Publisher transfer must be exactly 95%");
  invariant(
    objectId(transfer.destination) === settlementId,
    "Transfer destination changed",
  );
  invariant(
    objectId(transfer.source_transaction) === sourceCharge,
    "Transfer lost source charge",
  );
  return transfer;
}

async function fullyReverseTransfer(stripe, transfer, runRef, provePhases) {
  let current = await stripe.transfers.retrieve(transfer.id);
  invariant(
    !provePhases ||
      current.amount_reversed === 0 ||
      current.amount_reversed === 475 ||
      current.amount_reversed === current.amount,
    "Settlement transfer has an unrelated partial reversal",
  );
  if (provePhases && current.amount_reversed === 0) {
    const first = await stripe.transfers.createReversal(
      transfer.id,
      { amount: 475, metadata: { phase: "partial", runRef } },
      { idempotencyKey: `zevium-transfer-reversal:${runRef}:partial` },
    );
    const retry = await stripe.transfers.createReversal(
      transfer.id,
      { amount: 475, metadata: { phase: "partial", runRef } },
      { idempotencyKey: `zevium-transfer-reversal:${runRef}:partial` },
    );
    invariant(first.id === retry.id, "Reversal idempotency failed");
    current = await stripe.transfers.retrieve(transfer.id);
  }
  if (current.amount_reversed < current.amount) {
    await stripe.transfers.createReversal(
      transfer.id,
      {
        metadata: { phase: provePhases ? "remaining" : "compensation", runRef },
      },
      {
        idempotencyKey: `zevium-transfer-reversal:${runRef}:${provePhases ? "remaining" : "compensation"}`,
      },
    );
  }
  current = await stripe.transfers.retrieve(transfer.id);
  invariant(
    current.reversed === true && current.amount_reversed === current.amount,
    "Transfer compensation is incomplete",
  );
  return current;
}

async function payoutProof(stripe, runRef, settlementId) {
  const funding = await proofFundingIntent(
    stripe,
    runRef,
    "zevium_payout_proof_funding",
    100,
  );
  const transferGroup = `zevium-payout-proof-${runRef}`;
  const transfers = (
    await collectBounded(
      stripe.transfers.list({ transfer_group: transferGroup, limit: 100 }),
      "payout funding transfer list",
    )
  ).filter((transfer) => transfer.metadata?.purpose === "zevium_payout_proof");
  invariant(
    transfers.length <= 1,
    "Payout funding transfer correlation is ambiguous",
  );
  const transferParams = {
    amount: 100,
    currency: "usd",
    destination: settlementId,
    source_transaction: funding.chargeId,
    transfer_group: transferGroup,
    metadata: { purpose: "zevium_payout_proof", runRef },
  };
  const transferOptions = {
    idempotencyKey: `zevium-payout-funding:${runRef}`,
  };
  const transfer = await stripe.transfers.create(
    transferParams,
    transferOptions,
  );
  const transferRetry = await stripe.transfers.create(
    transferParams,
    transferOptions,
  );
  invariant(
    transfer.id === transferRetry.id,
    "Payout funding transfer idempotency failed",
  );
  if (transfers[0] !== undefined) {
    invariant(
      transfer.id === transfers[0].id,
      "Payout funding idempotency produced another transfer",
    );
  }
  invariant(
    objectId(transfer.source_transaction) === funding.chargeId,
    "Payout transfer lost source charge",
  );
  let paid = false;
  let payout;
  try {
    const payouts = (
      await collectBounded(
        stripe.payouts.list({ limit: 100 }, { stripeAccount: settlementId }),
        "connected payout list",
      )
    ).filter((payout) => payout.metadata?.runRef === runRef);
    invariant(payouts.length <= 1, "Connected payout correlation is ambiguous");
    const payoutParams = {
      amount: 100,
      currency: "usd",
      metadata: { purpose: "zevium_payout_proof", runRef },
    };
    const payoutOptions = {
      stripeAccount: settlementId,
      idempotencyKey: `zevium-connected-payout:${runRef}`,
    };
    payout = await stripe.payouts.create(payoutParams, payoutOptions);
    const payoutRetry = await stripe.payouts.create(
      payoutParams,
      payoutOptions,
    );
    invariant(payout.id === payoutRetry.id, "Payout idempotency failed");
    if (payouts[0] !== undefined) {
      invariant(
        payout.id === payouts[0].id,
        "Payout idempotency produced another payout",
      );
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      payout = await stripe.payouts.retrieve(
        payout.id,
        {},
        { stripeAccount: settlementId },
      );
      assertTestObject(payout, "Connected payout");
      if (payout.status === "paid") {
        paid = true;
        return {
          fundingIntentId: funding.intent.id,
          transferId: transfer.id,
          payout,
        };
      }
      if (["failed", "canceled"].includes(payout.status)) {
        throw new Error(`Connected payout ended ${payout.status}`);
      }
      await sleep(2_000);
    }
    throw new Error("Connected payout did not become paid within 60 seconds");
  } finally {
    if (!paid) {
      if (payout !== undefined) {
        const current = await stripe.payouts.retrieve(
          payout.id,
          {},
          { stripeAccount: settlementId },
        );
        if (current.status === "pending") {
          await stripe.payouts.cancel(
            current.id,
            {},
            { stripeAccount: settlementId },
          );
        }
      }
      await fullyReverseTransfer(stripe, transfer, `${runRef}:payout`, false);
    }
  }
}

async function findProviderFundingIntent(stripe, runRef, purpose) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const results = await collectBounded(
      stripe.paymentIntents.search({
        query: `metadata['runRef']:'${runRef}' AND metadata['purpose']:'${purpose}'`,
        limit: 100,
      }),
      `${purpose} cleanup search`,
    );
    invariant(
      results.length <= 1,
      `${purpose} cleanup correlation is ambiguous`,
    );
    if (results[0] !== undefined) return results[0];
    await sleep(1_000);
  }
  return null;
}

async function refundProviderFunding(stripe, runRef, purpose) {
  const summary = await findProviderFundingIntent(stripe, runRef, purpose);
  if (summary === null) return { purpose, status: "not_created" };
  const intent = await stripe.paymentIntents.retrieve(summary.id, {
    expand: ["latest_charge"],
  });
  assertTestObject(intent, `${purpose} cleanup PaymentIntent`);
  invariant(
    intent.status === "succeeded",
    `${purpose} funding did not succeed`,
  );
  const chargeId = requireId(
    objectId(intent.latest_charge),
    /^ch_[A-Za-z0-9]+$/,
    `${purpose} cleanup charge`,
  );
  let charge = await stripe.charges.retrieve(chargeId);
  assertTestObject(charge, `${purpose} cleanup charge`);
  let refundId = null;
  if (charge.amount_refunded < charge.amount) {
    const refund = await stripe.refunds.create(
      {
        payment_intent: intent.id,
        metadata: { purpose: "zevium_provider_proof_compensation", runRef },
      },
      { idempotencyKey: `zevium-provider-refund:${runRef}:${purpose}` },
    );
    assertTestObject(refund, `${purpose} cleanup refund`);
    invariant(refund.status === "succeeded", `${purpose} refund failed`);
    refundId = refund.id;
    charge = await stripe.charges.retrieve(chargeId);
  }
  invariant(
    charge.amount_refunded === charge.amount,
    `${purpose} provider funding was not fully refunded`,
  );
  return {
    purpose,
    status: "refunded",
    paymentIntentId: intent.id,
    chargeId,
    refundId,
  };
}

async function compensatePayout(stripe, runRef, settlementId) {
  const payouts = (
    await collectBounded(
      stripe.payouts.list({ limit: 100 }, { stripeAccount: settlementId }),
      "connected payout cleanup list",
    )
  ).filter(
    (payout) =>
      payout.metadata?.purpose === "zevium_payout_proof" &&
      payout.metadata?.runRef === runRef,
  );
  invariant(payouts.length <= 1, "Payout cleanup correlation is ambiguous");
  if (payouts[0] === undefined) return { status: "not_created" };
  let payout = await stripe.payouts.retrieve(
    payouts[0].id,
    {},
    { stripeAccount: settlementId },
  );
  assertTestObject(payout, "Connected payout cleanup");
  if (payout.reversed_by !== null) {
    const reversal = await stripe.payouts.retrieve(
      objectId(payout.reversed_by),
      {},
      { stripeAccount: settlementId },
    );
    invariant(
      objectId(reversal.original_payout) === payout.id &&
        reversal.status === "paid",
      "Existing payout reversal is incomplete",
    );
    return { status: "reversed", payoutId: payout.id, reversalId: reversal.id };
  }
  if (payout.status === "pending") {
    payout = await stripe.payouts.cancel(
      payout.id,
      {},
      { stripeAccount: settlementId },
    );
    invariant(payout.status === "canceled", "Pending payout did not cancel");
    return { status: "canceled", payoutId: payout.id };
  }
  for (
    let attempt = 0;
    payout.status === "in_transit" && attempt < 60;
    attempt += 1
  ) {
    await sleep(1_000);
    payout = await stripe.payouts.retrieve(
      payout.id,
      {},
      { stripeAccount: settlementId },
    );
  }
  if (payout.status === "failed" || payout.status === "canceled") {
    return { status: payout.status, payoutId: payout.id };
  }
  invariant(payout.status === "paid", `Payout cleanup found ${payout.status}`);
  let reversal = await stripe.payouts.reverse(
    payout.id,
    {},
    {
      stripeAccount: settlementId,
      idempotencyKey: `zevium-payout-reversal:${runRef}`,
    },
  );
  invariant(
    objectId(reversal.original_payout) === payout.id,
    "Payout reversal lost original payout correlation",
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    reversal = await stripe.payouts.retrieve(
      reversal.id,
      {},
      { stripeAccount: settlementId },
    );
    if (reversal.status === "paid") break;
    invariant(
      reversal.status !== "failed" && reversal.status !== "canceled",
      `Payout reversal ended ${reversal.status}`,
    );
    await sleep(1_000);
  }
  invariant(reversal.status === "paid", "Payout reversal did not settle");
  payout = await stripe.payouts.retrieve(
    payout.id,
    {},
    { stripeAccount: settlementId },
  );
  invariant(
    objectId(payout.reversed_by) === reversal.id,
    "Original payout does not reference reversal",
  );
  return { status: "reversed", payoutId: payout.id, reversalId: reversal.id };
}

async function findProofTransfer(stripe, runRef, purpose, transferGroup) {
  const transfers = (
    await collectBounded(
      stripe.transfers.list({ transfer_group: transferGroup, limit: 100 }),
      `${purpose} cleanup transfer list`,
    )
  ).filter(
    (transfer) =>
      transfer.metadata?.purpose === purpose &&
      transfer.metadata?.runRef === runRef,
  );
  invariant(transfers.length <= 1, `${purpose} cleanup is ambiguous`);
  return transfers[0] ?? null;
}

async function cleanupProviderRun() {
  const stripe = connectStripe();
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  const settlementId = requireId(
    process.env.STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID?.trim(),
    /^acct_[A-Za-z0-9]+$/,
    "Settlement account id",
  );
  let report;
  try {
    report = await readJson(reportPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    report = {
      schemaVersion: 3,
      reportType: "stripe-provider-supplemental",
      acceptance: false,
      acceptanceRole: "supplemental_only",
      generatedAt: new Date().toISOString(),
      runRef,
      status: "recovery_only",
      liveMoneyUsed: false,
      scope: "direct-stripe-primitives",
      provesZeviumLedgerCorrelation: false,
      onboardingCompleted: false,
    };
  }
  invariant(report.runRef === runRef, "Provider report belongs to another run");
  try {
    const accounts = await listProofAccounts(stripe, runRef);
    invariant(accounts.length <= 1, "Onboarding cleanup is ambiguous");
    let onboardingAccount = accounts[0] ?? null;
    if (onboardingAccount !== null && !onboardingAccount.closed) {
      onboardingAccount = await stripe.v2.core.accounts.close(
        onboardingAccount.id,
        { applied_configurations: onboardingAccount.applied_configurations },
      );
    }
    invariant(
      onboardingAccount === null || onboardingAccount.closed === true,
      "Onboarding proof account remains open",
    );

    const settlementTransfer = await findProofTransfer(
      stripe,
      runRef,
      "zevium_95_5_settlement_proof",
      `zevium-proof-${runRef}`,
    );
    const settlementCompensation =
      settlementTransfer === null
        ? { status: "not_created" }
        : await fullyReverseTransfer(
            stripe,
            settlementTransfer,
            `${runRef}:cleanup:settlement`,
            false,
          );

    const payoutCompensation = await compensatePayout(
      stripe,
      runRef,
      settlementId,
    );
    const payoutTransfer = await findProofTransfer(
      stripe,
      runRef,
      "zevium_payout_proof",
      `zevium-payout-proof-${runRef}`,
    );
    const payoutTransferCompensation =
      payoutTransfer === null
        ? { status: "not_created" }
        : await fullyReverseTransfer(
            stripe,
            payoutTransfer,
            `${runRef}:cleanup:payout`,
            false,
          );
    const fundingRefunds = [];
    for (const purpose of [
      "zevium_95_5_settlement_proof_funding",
      "zevium_payout_proof_funding",
    ]) {
      fundingRefunds.push(await refundProviderFunding(stripe, runRef, purpose));
    }
    report.compensation = {
      status: "passed",
      completedAt: new Date().toISOString(),
      onboardingAccountId: onboardingAccount?.id ?? null,
      onboardingClosed: onboardingAccount?.closed ?? true,
      settlementTransferStatus:
        settlementTransfer === null
          ? settlementCompensation.status
          : "fully_reversed",
      payout: payoutCompensation,
      payoutTransferStatus:
        payoutTransfer === null
          ? payoutTransferCompensation.status
          : "fully_reversed",
      fundingRefunds,
    };
    if (report.status === "proof_passed_pending_compensation") {
      report.status = "passed";
    }
    await writeSafeJson(reportPath, report);
    process.stdout.write("Stripe provider proof state fully compensated\n");
  } catch (error) {
    report.status = "cleanup_failed";
    report.compensation = {
      status: "failed",
      failedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message.slice(0, 240)
          : "Unknown cleanup failure",
    };
    await writeSafeJson(reportPath, report);
    throw error;
  }
}

async function providerSettlementProof() {
  const stripe = connectStripe();
  const runRef = normalizeRunRef(process.env.STRIPE_PROOF_RUN_REF);
  const report = {
    schemaVersion: 3,
    reportType: "stripe-provider-supplemental",
    acceptance: false,
    acceptanceRole: "supplemental_only",
    generatedAt: new Date().toISOString(),
    runRef,
    status: "running",
    liveMoneyUsed: false,
    scope: "direct-stripe-primitives",
    provesZeviumLedgerCorrelation: false,
    onboardingCompleted: false,
  };
  await writeSafeJson(reportPath, report);
  try {
    await onboardingProof(stripe, runRef, report);
    await writeSafeJson(reportPath, report);
    const settlementId = requireId(
      process.env.STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID?.trim(),
      /^acct_[A-Za-z0-9]+$/,
      "Settlement account id",
    );
    const settlement = await stripe.v2.core.accounts.retrieve(settlementId, {
      include: ["configuration.recipient", "defaults", "requirements"],
    });
    assertConnectAccount(settlement, "Settlement account");
    invariant(!settlement.closed, "Settlement account is closed");
    const capabilities =
      settlement.configuration?.recipient?.capabilities?.stripe_balance;
    invariant(
      capabilities?.stripe_transfers?.status === "active",
      "Settlement transfers inactive",
    );
    invariant(
      capabilities?.payouts?.status === "active",
      "Settlement payouts inactive",
    );

    const funding = await proofFundingIntent(
      stripe,
      runRef,
      "zevium_95_5_settlement_proof_funding",
      1_000,
    );
    const transfer = await proofTransfer(
      stripe,
      runRef,
      settlement.id,
      funding.chargeId,
    );
    let reversed;
    try {
      reversed = await fullyReverseTransfer(stripe, transfer, runRef, true);
    } finally {
      reversed = await fullyReverseTransfer(stripe, transfer, runRef, false);
    }
    const payout = await payoutProof(stripe, runRef, settlement.id);
    report.status = "proof_passed_pending_compensation";
    report.completedAt = new Date().toISOString();
    report.settlement = {
      accountId: settlement.id,
      transferCapability: capabilities.stripe_transfers.status,
      payoutCapability: capabilities.payouts.status,
      fundingPaymentIntentId: funding.intent.id,
      sourceChargeId: funding.chargeId,
      grossUsdCents: 1_000,
      publisherUsdCents: transfer.amount,
      platformUsdCents: 1_000 - transfer.amount,
      transferId: transfer.id,
      amountReversed: reversed.amount_reversed,
      payoutFundingPaymentIntentId: payout.fundingIntentId,
      payoutFundingTransferId: payout.transferId,
      payoutId: payout.payout.id,
      payoutStatus: payout.payout.status,
    };
    await writeSafeJson(reportPath, report);
    process.stdout.write(
      "Stripe provider primitives and compensation verified\n",
    );
  } catch (error) {
    report.status = "failed";
    report.failedAt = new Date().toISOString();
    report.error =
      error instanceof Error ? error.message.slice(0, 240) : "Unknown failure";
    await writeSafeJson(reportPath, report);
    throw error;
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "verify-deployments") await verifyDeployments();
  else if (command === "checkout") await checkoutSnapshot();
  else if (command === "refund" && ["partial", "remaining"].includes(args[0])) {
    await createRefund(args[0]);
  } else if (command === "begin-webhook-canary") await beginWebhookCanary();
  else if (command === "prove-canary-and-replay") await proveCanaryAndReplay();
  else if (command === "cleanup-webhook-canary") await cleanupWebhookCanary();
  else if (command === "wait-ledger") {
    await waitLedger(
      args[0],
      args[1],
      Number(args[3]),
      Number(args[2]),
      args[4],
      args[5] === undefined ? Number.POSITIVE_INFINITY : Number(args[5]),
    );
  } else if (command === "record-usage-proof") await recordUsageProof(args[0]);
  else if (command === "wait-usage") await waitUsage();
  else if (command === "app-baseline") await recordAppBaseline();
  else if (command === "record-app-onboarding")
    await recordAppOnboarding(args[0], args[1]);
  else if (command === "verify-app-onboarding")
    await verifyAppOnboardingProvider();
  else if (command === "record-app-transfer-ui")
    await recordAppTransferUi(args[0]);
  else if (command === "wait-app-transfer") await waitAppTransferLedger();
  else if (command === "verify-app-transfer") await verifyAppTransferProvider();
  else if (command === "wait-app-transfer-webhook")
    await waitAppTransferWebhook();
  else if (command === "compensate-app-transfer") await compensateAppTransfer();
  else if (command === "wait-app-compensation") await waitAppCompensation();
  else if (command === "finalize-acceptance") await finalizeAcceptanceReport();
  else if (command === "state-field") await printStateField(args[0]);
  else if (command === "expire-checkout") await expireCheckout();
  else if (command === "record-recovery-baseline")
    await recordPaymentRecoveryBaseline();
  else if (command === "recover-provider") await recoverPaymentProvider();
  else if (command === "recover-ledger") await recoverPaymentLedger();
  else if (command === "provider-settlement") await providerSettlementProof();
  else if (command === "provider-cleanup") await cleanupProviderRun();
  else if (command === "record-balance") await recordBalance(args[0], args[1]);
  else if (command === "record-provider-id")
    await recordProviderId(args[0], args[1]);
  else throw new Error("Unknown stripe provider proof command");
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown provider proof error";
  process.stderr.write(`stripe proof failed: ${message}\n`);
  process.exitCode = 1;
}
