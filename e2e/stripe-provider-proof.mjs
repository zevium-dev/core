#!/usr/bin/env node

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import Stripe from "stripe";

const API_VERSION = "2026-06-24.dahlia";
const statePath =
  process.env.PAYMENT_DRILL_STATE ??
  new URL("./artifacts/payment-drill-state.json", import.meta.url).pathname;
const reportPath =
  process.env.STRIPE_PROVIDER_REPORT ??
  new URL("./artifacts/stripe-provider-proof.json", import.meta.url).pathname;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  invariant(
    key?.startsWith("sk_test_"),
    "Stripe test-mode secret key required",
  );
  return new Stripe(key, { apiVersion: API_VERSION });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeSafeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function objectId(value) {
  return typeof value === "string" ? value : value?.id;
}

function assertTestObject(value, label) {
  invariant(value?.livemode === false, `${label} must be a test-mode object`);
}

async function checkoutSnapshot() {
  const stripe = stripeClient();
  const state = await readJson(statePath);
  invariant(
    /^cs_test_[A-Za-z0-9]+$/.test(state.checkoutSessionId ?? ""),
    "Payment drill state lacks a test Checkout Session",
  );
  const session = await stripe.checkout.sessions.retrieve(
    state.checkoutSessionId,
    { expand: ["payment_intent.latest_charge"] },
  );
  assertTestObject(session, "Checkout Session");
  invariant(session.mode === "payment", "Checkout Session mode changed");
  invariant(session.status === "complete", "Checkout Session is not complete");
  invariant(session.payment_status === "paid", "Checkout payment is not paid");
  invariant(
    session.amount_total === 1_000,
    "Checkout amount must be exactly $10",
  );
  invariant(session.currency === "usd", "Checkout currency must be USD");
  invariant(
    session.metadata?.packId === "pack_10",
    "Checkout pack metadata changed",
  );
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
    "PaymentIntent was not expanded",
  );
  assertTestObject(intent, "PaymentIntent");
  invariant(intent.status === "succeeded", "PaymentIntent did not succeed");
  invariant(
    intent.amount_received === 1_000,
    "PaymentIntent received amount changed",
  );
  const chargeId = objectId(intent.latest_charge);
  invariant(
    /^ch_[A-Za-z0-9]+$/.test(chargeId ?? ""),
    "Checkout charge is missing",
  );

  const expectedOrigin = new URL(process.env.E2E_BASE_URL).origin;
  invariant(
    new URL(session.success_url).origin === expectedOrigin,
    "Checkout success URL does not return to requested staging origin",
  );
  invariant(
    new URL(session.cancel_url).origin === expectedOrigin,
    "Checkout cancel URL does not return to requested staging origin",
  );

  await writeSafeJson(statePath, {
    ...state,
    checkoutIntentId: session.metadata.checkoutIntentId,
    clerkOrgId: session.metadata.clerkOrgId,
    paymentIntentId: intent.id,
    chargeId,
    checkoutVerifiedAt: new Date().toISOString(),
  });
  process.stdout.write("checkout provider facts verified\n");
}

async function createRefund(kind) {
  const stripe = stripeClient();
  let state = await readJson(statePath);
  if (
    !/^pi_[A-Za-z0-9]+$/.test(state.paymentIntentId ?? "") ||
    !/^ch_[A-Za-z0-9]+$/.test(state.chargeId ?? "")
  ) {
    invariant(
      /^cs_test_[A-Za-z0-9]+$/.test(state.checkoutSessionId ?? ""),
      "Payment drill state lacks a test Checkout Session",
    );
    const session = await stripe.checkout.sessions.retrieve(
      state.checkoutSessionId,
      { expand: ["payment_intent.latest_charge"] },
    );
    assertTestObject(session, "Checkout Session");
    if (session.payment_status !== "paid") {
      if (kind === "cleanup" && session.status === "open") {
        await stripe.checkout.sessions.expire(session.id);
        process.stdout.write("unpaid checkout expired during cleanup\n");
        return;
      }
      process.stdout.write("checkout has no paid charge to refund\n");
      return;
    }
    const intent = session.payment_intent;
    invariant(
      typeof intent === "object" && intent !== null,
      "PaymentIntent was not expanded",
    );
    const chargeId = objectId(intent.latest_charge);
    invariant(
      /^ch_[A-Za-z0-9]+$/.test(chargeId ?? ""),
      "Checkout charge is missing",
    );
    state = { ...state, paymentIntentId: intent.id, chargeId };
  }
  const charge = await stripe.charges.retrieve(state.chargeId);
  assertTestObject(charge, "Charge");
  const remaining = charge.amount - charge.amount_refunded;
  invariant(remaining >= 0, "Charge refund total exceeds charge amount");
  if (remaining === 0) {
    process.stdout.write("checkout already fully refunded\n");
    return;
  }
  const amount = kind === "partial" ? Math.min(250, remaining) : remaining;
  const refund = await stripe.refunds.create(
    {
      payment_intent: state.paymentIntentId,
      amount,
      metadata: {
        zevium_drill: "true",
        phase: kind,
      },
    },
    { idempotencyKey: `zevium-drill:${state.checkoutSessionId}:${kind}` },
  );
  assertTestObject(refund, "Refund");
  invariant(refund.status === "succeeded", `${kind} refund did not succeed`);
  invariant(refund.amount === amount, `${kind} refund amount changed`);
  const event = await findChargeRefundedEvent(stripe, state.chargeId);
  await writeSafeJson(statePath, {
    ...state,
    refunds: [
      ...(state.refunds ?? []).filter((entry) => entry.kind !== kind),
      { kind, id: refund.id, amount: refund.amount, status: refund.status },
    ],
    latestRefundEventId: event.id,
  });
  process.stdout.write(`${kind} refund provider facts verified\n`);
}

async function recordBalance(field, rawValue) {
  const allowed = new Set([
    "walletBeforeGrant",
    "walletAfterGrant",
    "walletBeforeRefund",
    "walletAfterPartialRefund",
    "walletAfterReplay",
    "walletAfterFullRefund",
  ]);
  invariant(allowed.has(field), "Unknown wallet proof field");
  const value = Number(rawValue);
  invariant(
    Number.isSafeInteger(value),
    "Wallet proof value must be an integer",
  );
  let state = { schemaVersion: 1 };
  try {
    state = await readJson(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeSafeJson(statePath, { ...state, [field]: value });
}

async function recordProviderId(field, value) {
  const patterns = {
    checkoutSessionId: /^cs_test_[A-Za-z0-9]+$/,
    terminalCheckoutSessionId: /^cs_test_[A-Za-z0-9]+$/,
  };
  invariant(patterns[field]?.test(value ?? ""), "Invalid provider proof id");
  const state = await readJson(statePath);
  await writeSafeJson(statePath, { ...state, [field]: value });
}

async function findChargeRefundedEvent(stripe, chargeId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await stripe.events.list({
      type: "charge.refunded",
      limit: 100,
    });
    const event = events.data.find(
      (candidate) => candidate.data.object.id === chargeId,
    );
    if (event !== undefined) {
      assertTestObject(event, "Stripe event");
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("charge.refunded event did not appear");
}

async function replayLatestRefund() {
  const stripe = stripeClient();
  const state = await readJson(statePath);
  invariant(
    /^evt_[A-Za-z0-9]+$/.test(state.latestRefundEventId ?? ""),
    "Payment drill state lacks a refund event",
  );
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const expectedUrl = process.env.STRIPE_WEBHOOK_ENDPOINT_URL?.trim();
  const matches = endpoints.data.filter((endpoint) => {
    if (endpoint.status !== "enabled") return false;
    if (expectedUrl) return endpoint.url === expectedUrl;
    try {
      return new URL(endpoint.url).pathname === "/stripe-webhook";
    } catch {
      return false;
    }
  });
  invariant(
    matches.length === 1,
    `Expected one enabled Stripe billing webhook endpoint, found ${matches.length}`,
  );
  const endpoint = matches[0];
  await stripe.rawRequest(
    "POST",
    `/v1/events/${encodeURIComponent(state.latestRefundEventId)}/retry`,
    { webhook_endpoint: endpoint.id },
    {
      idempotencyKey: `zevium-replay:${state.latestRefundEventId}:${endpoint.id}`,
    },
  );
  await writeSafeJson(statePath, {
    ...state,
    webhookReplay: {
      eventId: state.latestRefundEventId,
      endpointId: endpoint.id,
      deliveredAt: new Date().toISOString(),
    },
  });
  process.stdout.write("signed Stripe webhook replay requested\n");
}

async function configuredBillingEndpoint(stripe, expectedUrl) {
  invariant(expectedUrl, "STRIPE_WEBHOOK_ENDPOINT_URL is required");
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const matches = endpoints.data.filter(
    (endpoint) => endpoint.status === "enabled" && endpoint.url === expectedUrl,
  );
  invariant(
    matches.length === 1,
    `Expected one enabled Stripe billing webhook endpoint, found ${matches.length}`,
  );
  return matches[0];
}

async function beginWebhookOutage() {
  const stripe = stripeClient();
  const state = await readJson(statePath);
  const originalUrl = process.env.STRIPE_WEBHOOK_ENDPOINT_URL?.trim();
  const endpoint = await configuredBillingEndpoint(stripe, originalUrl);
  const original = new URL(originalUrl);
  const failureUrl = `${original.origin}/stripe-proof-intentional-404`;
  await writeSafeJson(statePath, {
    ...state,
    webhookOutage: {
      endpointId: endpoint.id,
      originalUrl,
      failureUrl,
      startedAt: new Date().toISOString(),
    },
  });
  await stripe.webhookEndpoints.update(endpoint.id, { url: failureUrl });
  const updated = await stripe.webhookEndpoints.retrieve(endpoint.id);
  invariant(
    updated.url === failureUrl,
    "Stripe webhook outage was not installed",
  );
  process.stdout.write("intentional webhook delivery outage installed\n");
}

async function restoreWebhook() {
  const stripe = stripeClient();
  const state = await readJson(statePath);
  const outage = state.webhookOutage;
  if (!outage?.endpointId || !outage?.originalUrl) {
    process.stdout.write("no webhook outage to restore\n");
    return;
  }
  const current = await stripe.webhookEndpoints.retrieve(outage.endpointId);
  if (current.url !== outage.originalUrl) {
    await stripe.webhookEndpoints.update(outage.endpointId, {
      url: outage.originalUrl,
    });
  }
  const restored = await stripe.webhookEndpoints.retrieve(outage.endpointId);
  invariant(
    restored.url === outage.originalUrl,
    "Stripe webhook endpoint was not restored",
  );
  await writeSafeJson(statePath, {
    ...state,
    webhookOutage: {
      ...outage,
      restoredAt: new Date().toISOString(),
    },
  });
  process.stdout.write("Stripe webhook endpoint restored\n");
}

async function proveFailedDeliveryAndReplay() {
  const stripe = stripeClient();
  let state = await readJson(statePath);
  invariant(state.webhookOutage?.endpointId, "Webhook outage proof is missing");
  const event = await findChargeRefundedEvent(stripe, state.chargeId);
  let failedDeliveryObserved = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await stripe.events.retrieve(event.id);
    if (current.pending_webhooks > 0) {
      failedDeliveryObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  invariant(
    failedDeliveryObserved,
    "Stripe did not retain the failed webhook delivery",
  );
  await restoreWebhook();
  state = await readJson(statePath);
  await stripe.rawRequest(
    "POST",
    `/v1/events/${encodeURIComponent(event.id)}/retry`,
    { webhook_endpoint: state.webhookOutage.endpointId },
    { idempotencyKey: `zevium-failed-delivery-replay:${event.id}` },
  );
  await writeSafeJson(statePath, {
    ...state,
    latestRefundEventId: event.id,
    failedWebhookDelivery: {
      eventId: event.id,
      endpointId: state.webhookOutage.endpointId,
      pendingDeliveryObserved: true,
      replayRequestedAt: new Date().toISOString(),
    },
  });
  process.stdout.write("failed signed webhook delivery replayed\n");
}

async function expireCheckout() {
  const stripe = stripeClient();
  const state = await readJson(statePath);
  const sessionId = state.terminalCheckoutSessionId;
  invariant(
    /^cs_test_[A-Za-z0-9]+$/.test(sessionId ?? ""),
    "Terminal Checkout Session is missing",
  );
  let session = await stripe.checkout.sessions.retrieve(sessionId);
  assertTestObject(session, "Checkout Session");
  invariant(
    session.payment_status === "unpaid",
    "Terminal proof checkout was paid",
  );
  if (session.status === "open") {
    session = await stripe.checkout.sessions.expire(sessionId);
  }
  invariant(session.status === "expired", "Checkout Session did not expire");
  const events = await stripe.events.list({
    type: "checkout.session.expired",
    limit: 100,
  });
  const event = events.data.find(
    (candidate) => candidate.data.object.id === sessionId,
  );
  invariant(event !== undefined, "Stripe expiry event is missing");
  await writeSafeJson(statePath, {
    ...state,
    terminalCheckout: {
      checkoutSessionId: sessionId,
      eventId: event.id,
      providerStatus: session.status,
    },
  });
  process.stdout.write("Checkout expiry provider facts verified\n");
}

async function providerSettlementProof() {
  const stripe = stripeClient();
  const runRef = (process.env.STRIPE_PROOF_RUN_REF ?? `${Date.now()}`).replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

  const onboarding = await stripe.v2.core.accounts.create(
    {
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
            stripe_balance: {
              stripe_transfers: { requested: true },
            },
          },
        },
      },
      contact_email: `stripe-proof+${runRef}@example.com`,
      display_name: `Zevium proof ${runRef}`,
      identity: { country: "US" },
      metadata: { purpose: "zevium_connect_onboarding_proof", runRef },
      include: ["configuration.recipient", "defaults", "requirements"],
    },
    { idempotencyKey: `zevium-onboarding:${runRef}` },
  );
  assertTestObject(onboarding, "Connected account");
  invariant(
    onboarding.dashboard === "express",
    "Onboarding account is not Express",
  );
  invariant(
    onboarding.defaults?.responsibilities?.fees_collector === "application" &&
      onboarding.defaults?.responsibilities?.losses_collector === "application",
    "Connect loss or fee responsibility changed",
  );
  invariant(
    onboarding.applied_configurations.includes("recipient"),
    "Recipient configuration was not applied",
  );
  const onboardingLink = await stripe.accountLinks.create({
    account: onboarding.id,
    type: "account_onboarding",
    refresh_url: "https://example.com/stripe-proof/refresh",
    return_url: "https://example.com/stripe-proof/return",
  });
  invariant(
    new URL(onboardingLink.url).hostname.endsWith("stripe.com"),
    "Stripe did not return a hosted onboarding URL",
  );

  const listed = await stripe.v2.core.accounts.list({
    applied_configurations: ["recipient"],
    limit: 20,
  });
  const settlementSummary = listed.data.find(
    (account) => account.metadata?.purpose === "zevium_usd_settlement_e2e",
  );
  invariant(
    settlementSummary !== undefined,
    "Active settlement proof account is missing",
  );
  const settlement = await stripe.v2.core.accounts.retrieve(
    settlementSummary.id,
    {
      include: ["configuration.recipient", "defaults", "requirements"],
    },
  );
  assertTestObject(settlement, "Settlement account");
  const capabilities =
    settlement.configuration?.recipient?.capabilities?.stripe_balance;
  invariant(
    capabilities?.stripe_transfers?.status === "active",
    "Settlement account transfers are not active",
  );
  invariant(
    capabilities?.payouts?.status === "active",
    "Settlement account payouts are not active",
  );

  const fundingIntent = await stripe.paymentIntents.create(
    {
      amount: 3_000,
      currency: "usd",
      payment_method: "pm_card_bypassPending",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { purpose: "zevium_provider_proof_funding", runRef },
    },
    { idempotencyKey: `zevium-provider-funding:${runRef}` },
  );
  assertTestObject(fundingIntent, "Funding PaymentIntent");
  invariant(
    fundingIntent.status === "succeeded",
    "Platform proof funding failed",
  );

  const transferParams = {
    amount: 950,
    currency: "usd",
    destination: settlement.id,
    transfer_group: `zevium-proof-${runRef}`,
    metadata: {
      purpose: "zevium_95_5_settlement_proof",
      grossUsdCents: "1000",
      publisherUsdCents: "950",
      platformUsdCents: "50",
      runRef,
    },
  };
  const transferOptions = {
    idempotencyKey: `zevium-95-5-transfer:${runRef}`,
  };
  const transfer = await stripe.transfers.create(
    transferParams,
    transferOptions,
  );
  const transferRetry = await stripe.transfers.create(
    transferParams,
    transferOptions,
  );
  assertTestObject(transfer, "Transfer");
  invariant(transfer.id === transferRetry.id, "Transfer idempotency failed");
  invariant(transfer.amount === 950, "Publisher transfer must be exactly 95%");
  invariant(
    objectId(transfer.destination) === settlement.id,
    "Transfer destination changed",
  );

  const firstReversal = await stripe.transfers.createReversal(
    transfer.id,
    { amount: 475, metadata: { phase: "partial", runRef } },
    { idempotencyKey: `zevium-transfer-reversal:${runRef}:partial` },
  );
  const firstReversalRetry = await stripe.transfers.createReversal(
    transfer.id,
    { amount: 475, metadata: { phase: "partial", runRef } },
    { idempotencyKey: `zevium-transfer-reversal:${runRef}:partial` },
  );
  invariant(
    firstReversal.id === firstReversalRetry.id,
    "Reversal idempotency failed",
  );
  const finalReversal = await stripe.transfers.createReversal(
    transfer.id,
    { amount: 475, metadata: { phase: "remaining", runRef } },
    { idempotencyKey: `zevium-transfer-reversal:${runRef}:remaining` },
  );
  const reversedTransfer = await stripe.transfers.retrieve(transfer.id);
  invariant(
    reversedTransfer.reversed === true &&
      reversedTransfer.amount_reversed === 950,
    "Transfer was not fully reversed",
  );

  const payoutFunding = await stripe.transfers.create(
    {
      amount: 100,
      currency: "usd",
      destination: settlement.id,
      metadata: { purpose: "zevium_payout_proof", runRef },
    },
    { idempotencyKey: `zevium-payout-funding:${runRef}` },
  );
  const payout = await stripe.payouts.create(
    { amount: 100, currency: "usd", metadata: { runRef } },
    {
      stripeAccount: settlement.id,
      idempotencyKey: `zevium-connected-payout:${runRef}`,
    },
  );
  const finalPayout = await waitForPayout(stripe, settlement.id, payout.id);

  await writeSafeJson(reportPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runRef,
    liveMoneyUsed: false,
    scope: "stripe-provider-primitives-only",
    provesZeviumLedgerCorrelation: false,
    onboarding: {
      accountId: onboarding.id,
      hostedLinkCreated: true,
      onboardingCompleted: false,
      dashboard: onboarding.dashboard,
      appliedConfigurations: onboarding.applied_configurations,
      feeResponsibility: onboarding.defaults.responsibilities.fees_collector,
      lossResponsibility: onboarding.defaults.responsibilities.losses_collector,
      transferCapability:
        onboarding.configuration?.recipient?.capabilities?.stripe_balance
          ?.stripe_transfers?.status ?? "pending",
      requirements: onboarding.requirements?.entries?.length ?? 0,
      hostedLinkOrigin: new URL(onboardingLink.url).origin,
    },
    settlement: {
      accountId: settlement.id,
      transferCapability: capabilities.stripe_transfers.status,
      payoutCapability: capabilities.payouts.status,
      grossUsdCents: 1_000,
      publisherUsdCents: transfer.amount,
      platformUsdCents: 1_000 - transfer.amount,
      transferId: transfer.id,
      idempotentTransferId: transferRetry.id,
      reversalIds: [firstReversal.id, finalReversal.id],
      amountReversed: reversedTransfer.amount_reversed,
      payoutFundingTransferId: payoutFunding.id,
      payoutId: finalPayout.id,
      payoutStatus: finalPayout.status,
    },
  });
  process.stdout.write(
    "Stripe onboarding-link, transfer, reversal, and payout primitives verified\n",
  );
}

async function waitForPayout(stripe, accountId, payoutId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const payout = await stripe.payouts.retrieve(
      payoutId,
      {},
      { stripeAccount: accountId },
    );
    assertTestObject(payout, "Payout");
    if (payout.status === "paid") return payout;
    if (payout.status === "failed" || payout.status === "canceled") {
      throw new Error(`Connected payout ended ${payout.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Connected payout did not become paid within 60 seconds");
}

const [command, argument, secondArgument] = process.argv.slice(2);
try {
  if (command === "checkout") await checkoutSnapshot();
  else if (
    command === "refund" &&
    ["partial", "remaining", "cleanup"].includes(argument)
  ) {
    await createRefund(argument);
  } else if (command === "replay-refund") await replayLatestRefund();
  else if (command === "begin-webhook-outage") await beginWebhookOutage();
  else if (command === "restore-webhook") await restoreWebhook();
  else if (command === "prove-failed-delivery")
    await proveFailedDeliveryAndReplay();
  else if (command === "expire-checkout") await expireCheckout();
  else if (command === "provider-settlement") await providerSettlementProof();
  else if (command === "record-balance")
    await recordBalance(argument, secondArgument);
  else if (command === "record-provider-id")
    await recordProviderId(argument, secondArgument);
  else {
    throw new Error("Unknown stripe provider proof command");
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown provider proof error";
  process.stderr.write(`stripe proof failed: ${message}\n`);
  process.exitCode = 1;
}
