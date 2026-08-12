#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import Stripe from "stripe";
import {
  MAX_PROVIDER_OBJECTS,
  STRIPE_API_VERSION,
  assertExclusiveEndpointTopology,
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
  const state = (await readStateOrNull()) ?? { schemaVersion: 2 };
  const next = { ...state, schemaVersion: 2, ...patch };
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
  canonicalEndpoint(endpoints);
  await updateState({
    webhookCanaryCleanup: {
      deletedEndpointIds: deleted,
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
  await stripe.rawRequest(
    "POST",
    `/v1/events/${encodeURIComponent(eventId)}/retry`,
    { webhook_endpoint: canonical.id },
    { idempotencyKey: `zevium-canonical-replay:${eventId}:${canonical.id}` },
  );
  await updateState({
    failedWebhookDelivery: {
      eventId,
      canaryEndpointId: canaryId,
      canonicalEndpointId: canonical.id,
      exactPendingDeliveries: 1,
      canonicalReceiptDeliveries: 1,
      exclusiveV1SubscriberIds: [canonical.id, canaryId],
      competingV2SubscriberCount: competingV2Destinations.length,
      canaryDeletedAt: new Date().toISOString(),
      canonicalReplayRequestedAt: new Date().toISOString(),
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
if (payment === null) return { payment: null, wallet: null, event: null, reversalJournalCredits: 0, disputeCount: 0 };
const wallets = await ctx.db.query("wallets").withIndex("by_organization", q => q.eq("organizationId", payment.organizationId)).take(2);
if (wallets.length > 1) throw new Error("duplicate organization wallet");
const wallet = wallets[0] ?? null;
const events = ${eventLiteral} === null ? [] : await ctx.db.query("paymentEvents").withIndex("by_stripe_event", q => q.eq("stripeEventId", ${eventLiteral})).take(2);
if (events.length > 1) throw new Error("duplicate Stripe event receipt");
const reversals = await ctx.db.query("walletFundingReversals").withIndex("by_payment_created", q => q.eq("paymentId", payment._id)).take(501);
if (reversals.length > 500) throw new Error("reversal journal proof exceeded 500 rows");
const disputes = await ctx.db.query("paymentDisputes").withIndex("by_payment", q => q.eq("paymentId", payment._id)).take(101);
if (disputes.length > 100) throw new Error("dispute proof exceeded 100 rows");
return {
  payment: {
    id: String(payment._id),
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
  disputeCount: disputes.length
};`;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "convex", "run", "--codegen", "disable", "--inline-query", source],
    { env: process.env, maxBuffer: 2_000_000, timeout: 30_000 },
  );
  try {
    return JSON.parse(stdout.trim());
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
    project: { slug: project.slug }
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
    return JSON.parse(stdout.trim());
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

async function recoverPaymentDrill() {
  await cleanupWebhookCanary();
  const state = await readStateOrNull();
  if (state === null || !state.checkoutSessionId) {
    process.stdout.write("no payment state to recover\n");
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
  let before;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    before = await convexEvidence(state.checkoutSessionId, null);
    if (before.payment !== null && before.wallet !== null) break;
    await sleep(2_000);
  }
  invariant(
    before?.payment !== null && before?.wallet !== null,
    "Paid checkout is absent from Convex",
  );
  const charge = resolved.charge;
  if (charge.amount_refunded < charge.amount) await createRefund("remaining");
  const current = await stripe.charges.retrieve(charge.id);
  invariant(
    current.amount_refunded === current.amount,
    "Recovery refund is incomplete",
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
    ledgerSnapshots: {
      ...(state.ledgerSnapshots ?? {}),
      recoveryBaseline: before,
    },
    fullRefundEventId: event.id,
  });
  await waitLedger("recovery", event.id, 100_000, 1, "recoveryBaseline");
  process.stdout.write("paid checkout and Convex ledger fully recovered\n");
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
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      runRef,
      status: "recovery_only",
      liveMoneyUsed: false,
      scope: "stripe-provider-primitives-only",
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
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runRef,
    status: "running",
    liveMoneyUsed: false,
    scope: "stripe-provider-primitives-only",
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
  if (command === "checkout") await checkoutSnapshot();
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
  else if (command === "state-field") await printStateField(args[0]);
  else if (command === "expire-checkout") await expireCheckout();
  else if (command === "recover") await recoverPaymentDrill();
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
