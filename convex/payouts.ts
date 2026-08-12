import Stripe from "stripe";
import {
  signTransferCorrelation,
  verifyTransferCorrelation,
} from "@zevium/shared";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ACCOUNTING_ATOMS_PER_USD_CENT,
  PUBLISHER_MINIMUM_PAYOUT_ATOMS,
  atomsToCredits,
  atomsToUsdCents,
} from "./accounting";
import { getOrgByClerkId, requireIdentity, requireOrgAdmin } from "./lib/auth";

import {
  adjustPublisherBalanceAggregates,
  appendPublisherSettlementEntry,
  assertPublisherBalanceReady,
  getOrCreatePublisherBalance,
  releasePublisherEarning,
} from "./lib/publisherLedger";
import { stripeClient } from "./billing";
import {
  assertFinanceMigrationAllowsRuntime,
  FINANCE_MIGRATION_KEY,
} from "./lib/financeMigrationGate";

export type ConnectProfileStatus =
  "not_started" | "incomplete" | "restricted" | "enabled";

function transferCorrelationSecret(): string {
  const secret = process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error(
      "STRIPE_TRANSFER_CORRELATION_SECRET must contain at least 32 bytes",
    );
  }
  return secret;
}

export function stripePlatformAccountId(): string {
  const accountId = process.env.STRIPE_PLATFORM_ACCOUNT_ID;
  if (accountId === undefined || !/^acct_[A-Za-z0-9]+$/.test(accountId)) {
    throw new Error("STRIPE_PLATFORM_ACCOUNT_ID is not configured");
  }
  return accountId;
}

function randomCorrelationNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export const STRIPE_TRANSFER_SAFE_RETRY_MS = 23 * 60 * 60 * 1000;
const STRIPE_TRANSFER_LEASE_MS = 5 * 60 * 1000;
const STRIPE_TRANSFER_LIST_PAGE_SIZE = 100;
const STRIPE_TRANSFER_LIST_MAX_PAGES = 20;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function transferRequestFingerprint(args: {
  publisherTransferId: string;
  publisherOrganizationId: string;
  destination: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  correlationNonce: string;
  correlationHmac: string;
  platformAccountId: string;
}): Promise<string> {
  return await sha256Hex(
    JSON.stringify([
      2,
      args.publisherTransferId,
      args.publisherOrganizationId,
      args.destination,
      args.amount,
      args.currency.toLowerCase(),
      args.idempotencyKey,
      args.correlationNonce,
      args.correlationHmac,
      args.platformAccountId,
    ]),
  );
}

/** Test seam for deterministic account-link creation. */
export type ConnectOnboardingClient = {
  accountsV2: {
    create: (
      params: Stripe.V2.Core.AccountCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Pick<Stripe.V2.Core.Account, "id">>;
  };
  accountLinks: {
    create: (
      params: Stripe.AccountLinkCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Pick<Stripe.AccountLink, "url">>;
  };
};

export async function createOnboardingLink(
  stripe: ConnectOnboardingClient,
  args: {
    connectedAccountId: string | null;
    clerkOrgId: string;
    organizationId: string;
    country: string | null;
    contactEmail: string;
    refreshUrl: string;
    returnUrl: string;
  },
): Promise<{ connectedAccountId: string; url: string }> {
  let connectedAccountId = args.connectedAccountId;
  if (connectedAccountId === null) {
    if (args.country === null || !/^[A-Z]{2}$/.test(args.country)) {
      throw new Error(
        "Publisher country must be a two-letter ISO country code",
      );
    }
    const account = await stripe.accountsV2.create(
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
        contact_email: args.contactEmail,
        identity: { country: args.country },
        metadata: { clerkOrgId: args.clerkOrgId },
      },
      { idempotencyKey: `connect-account:${args.organizationId}` },
    );
    connectedAccountId = account.id;
  }
  const link = await stripe.accountLinks.create({
    account: connectedAccountId,
    type: "account_onboarding",
    refresh_url: args.refreshUrl,
    return_url: args.returnUrl,
  });
  if (link.url.trim() === "")
    throw new Error("Stripe did not return an onboarding URL");
  return { connectedAccountId, url: link.url };
}

export const getConnectProfileForActiveOrg = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const organization = await getOrgByClerkId(ctx, args.clerkOrgId);

    if (organization === null)
      throw new Error("Active organization is not provisioned");
    let profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .unique();
    if (profile === null) {
      const profileId = await ctx.db.insert("organizationPayments", {
        organizationId: organization._id,
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: [],
        updatedAt: Date.now(),
      });
      profile = await ctx.db.get(profileId);
      if (profile === null) throw new Error("Failed to create payment profile");
    }
    return {
      organizationId: organization._id,
      stripeConnectedAccountId: profile.stripeConnectedAccountId ?? null,
    };
  },
});

export const setConnectedAccount = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    stripeConnectedAccountId: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const existing = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .unique();
    if (existing === null) throw new Error("Payment profile not found");
    if (
      existing.stripeConnectedAccountId !== undefined &&
      existing.stripeConnectedAccountId !== args.stripeConnectedAccountId
    ) {
      return existing.stripeConnectedAccountId;
    }
    await ctx.db.patch(existing._id, {
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      updatedAt: Date.now(),
    });
    return args.stripeConnectedAccountId;
  },
});

export const projectConnectedAccount = internalMutation({
  args: {
    stripeConnectedAccountId: v.string(),
    detailsSubmitted: v.boolean(),
    chargesEnabled: v.boolean(),
    payoutsEnabled: v.boolean(),
    disabledReason: v.optional(v.string()),
    requirements: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", args.stripeConnectedAccountId),
      )
      .unique();
    if (profile === null) return;
    await ctx.db.patch(profile._id, {
      detailsSubmitted: args.detailsSubmitted,
      chargesEnabled: args.chargesEnabled,
      payoutsEnabled: args.payoutsEnabled,
      disabledReason: args.disabledReason,
      requirements: [...new Set(args.requirements)].sort(),
      updatedAt: Date.now(),
    });
  },
});

export function connectAccountProjection(account: Stripe.V2.Core.Account) {
  const transferCapability =
    account.configuration?.recipient?.capabilities?.stripe_balance
      ?.stripe_transfers;
  const payoutCapability =
    account.configuration?.recipient?.capabilities?.stripe_balance?.payouts;
  const requirements = (account.requirements?.entries ?? [])
    .filter(
      (entry) =>
        entry.awaiting_action_from === "user" &&
        entry.minimum_deadline.status !== "eventually_due",
    )
    .map((entry) => entry.description);
  const transfersActive = transferCapability?.status === "active";
  const payoutsActive = payoutCapability?.status === "active";
  return {
    detailsSubmitted: requirements.length === 0,
    chargesEnabled: false,
    payoutsEnabled: transfersActive && payoutsActive,
    disabledReason:
      transfersActive && payoutsActive
        ? undefined
        : `Transfers: ${transferCapability?.status ?? "pending"}; payouts: ${
            payoutCapability?.status ?? "pending"
          }`,
    requirements,
  };
}

export const refreshConnectedAccount = internalAction({
  args: { stripeConnectedAccountId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const account = await stripeClient().v2.core.accounts.retrieve(
      args.stripeConnectedAccountId,
      { include: ["configuration.recipient", "requirements"] },
    );
    if (account.closed === true) return;
    await ctx.runMutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: account.id,
      ...connectAccountProjection(account),
    });
  },
});

export const startOnboarding = action({
  args: { country: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    if (claims.orgId === undefined) {
      throw new Error("Active organization required");
    }
    const country = args.country?.trim().toUpperCase() ?? null;
    const identity = await ctx.auth.getUserIdentity();
    const clerkOrgId = claims.orgId;

    const contactEmail =
      identity !== null && typeof identity.email === "string"
        ? identity.email.trim()
        : "";
    if (contactEmail === "") {
      throw new Error("Signed-in user email is required for Stripe onboarding");
    }
    const prepared = await ctx.runMutation(
      internal.payouts.getConnectProfileForActiveOrg,
      {
        clerkOrgId,
      },
    );
    const origin = process.env.APP_ORIGIN;
    if (origin === undefined || origin.trim() === "")
      throw new Error("APP_ORIGIN is not configured");
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("APP_ORIGIN must use HTTPS outside localhost");
    }
    const stripe = stripeClient();
    const created = await createOnboardingLink(
      {
        accountsV2: stripe.v2.core.accounts,
        accountLinks: stripe.accountLinks,
      },
      {
        connectedAccountId: prepared.stripeConnectedAccountId,
        clerkOrgId,
        organizationId: prepared.organizationId,
        country,
        contactEmail,
        refreshUrl: `${url.origin}/app/earnings?onboarding=refresh`,
        returnUrl: `${url.origin}/app/earnings?onboarding=return`,
      },
    );
    await ctx.runMutation(internal.payouts.setConnectedAccount, {
      organizationId: prepared.organizationId,
      stripeConnectedAccountId: created.connectedAccountId,
    });
    return { url: created.url };
  },
});

export const releaseMatureEarnings = internalMutation({
  args: { publisherOrganizationId: v.id("organizations") },
  handler: async (ctx, args): Promise<{ released: number }> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher_status_available", (q) =>
        q
          .eq("publisherOrganizationId", args.publisherOrganizationId)
          .eq("status", "pending_risk")
          .lte("availableAt", now),
      )
      .take(25);
    for (const earning of pending) {
      await releasePublisherEarning(ctx, earning);
    }
    if (pending.length === 25) {
      await ctx.scheduler.runAfter(0, internal.payouts.releaseMatureEarnings, {
        publisherOrganizationId: args.publisherOrganizationId,
      });
    }
    return { released: pending.length };
  },
});

/** Global bounded release queue; each chunk reschedules itself atomically. */
export const releaseMatureEarningsGlobal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ released: number }> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_status_available", (q) =>
        q.eq("status", "pending_risk").lte("availableAt", now),
      )
      .take(25);
    for (const earning of pending) {
      await releasePublisherEarning(ctx, earning);
    }
    if (pending.length === 25) {
      await ctx.scheduler.runAfter(
        0,
        internal.payouts.releaseMatureEarningsGlobal,
        {},
      );
    }
    return { released: pending.length };
  },
});

export const preparePublisherTransfer = internalMutation({
  args: {
    publisherOrganizationId: v.id("organizations"),
    correlationNonce: v.string(),
    platformAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    if (!/^[0-9a-f]{64}$/.test(args.correlationNonce)) {
      throw new Error(
        "Transfer correlation nonce must contain 256 random bits",
      );
    }
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.publisherOrganizationId),
      )
      .unique();
    if (
      profile === null ||
      profile.stripeConnectedAccountId === undefined ||
      !profile.payoutsEnabled ||
      profile.disabledReason !== undefined
    ) {
      throw new Error("Connected account is not eligible for transfers");
    }
    const retryCandidates = await Promise.all(
      (["created", "pending", "failed"] as const).map(
        async (status) =>
          await ctx.db
            .query("publisherTransfers")
            .withIndex("by_publisher_status", (q) =>
              q
                .eq("publisherOrganizationId", args.publisherOrganizationId)
                .eq("status", status),
            )
            .order("desc")
            .first(),
      ),
    );
    const retry = retryCandidates
      .filter((candidate) => candidate !== null)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (retry !== undefined) {
      if (
        retry.correlationState === "provider_repair_required" ||
        retry.correlationState === undefined ||
        retry.metadataRepairVersion !== 2 ||
        retry.providerCreateMetadataShape !== "correlated_v2" ||
        retry.correlationNonce === undefined ||
        retry.correlationHmac === undefined ||
        retry.platformAccountId === undefined ||
        retry.requestFingerprint === undefined
      ) {
        throw new Error("Legacy transfer provider metadata repair is required");
      }
      const dispatch = await ctx.db
        .query("publisherTransferDispatches")
        .withIndex("by_transfer", (q) => q.eq("transferId", retry._id))
        .unique();
      if (
        dispatch === null ||
        dispatch.requestFingerprint !== retry.requestFingerprint ||
        dispatch.state === "provider_reconciliation_required"
      ) {
        throw new Error("Transfer provider reconciliation is required");
      }
      return {
        transferId: retry._id,
        connectedAccountId: retry.stripeConnectedAccountId,
        amount: retry.amount,
        remainderAtoms: retry.remainderAtoms,
        currency: retry.currency,
        idempotencyKey: retry.idempotencyKey,
        correlationNonce: retry.correlationNonce,
        correlationHmac: retry.correlationHmac,
        platformAccountId: retry.platformAccountId,
        correlationState: retry.correlationState,
        metadataRepairVersion: retry.metadataRepairVersion,
        providerCreateMetadataShape: retry.providerCreateMetadataShape,
        stripeTransferId: retry.stripeTransferId,
        requestFingerprint: retry.requestFingerprint,
      };
    }
    const balance = await getOrCreatePublisherBalance(
      ctx,
      args.publisherOrganizationId,
    );
    if (balance.availableAtoms < PUBLISHER_MINIMUM_PAYOUT_ATOMS) {
      throw new Error(
        "Available earnings must reach the $10.00 payout minimum",
      );
    }
    const amount = atomsToUsdCents(balance.availableAtoms);
    const amountAtoms = amount * ACCOUNTING_ATOMS_PER_USD_CENT;
    const remainderAtoms = balance.availableAtoms - amountAtoms;
    const idempotencyKey = `publisher-transfer:${args.publisherOrganizationId}:${balance.sequence + 1}`;
    const existing = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_idempotency_key", (q) =>
        q.eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.correlationState === "provider_repair_required" ||
        existing.correlationState === undefined ||
        existing.metadataRepairVersion !== 2 ||
        existing.providerCreateMetadataShape !== "correlated_v2" ||
        existing.correlationNonce === undefined ||
        existing.correlationHmac === undefined ||
        existing.platformAccountId === undefined ||
        existing.requestFingerprint === undefined
      ) {
        throw new Error("Legacy transfer provider metadata repair is required");
      }
      const dispatch = await ctx.db
        .query("publisherTransferDispatches")
        .withIndex("by_transfer", (q) => q.eq("transferId", existing._id))
        .unique();
      if (
        dispatch === null ||
        dispatch.requestFingerprint !== existing.requestFingerprint ||
        dispatch.state === "provider_reconciliation_required"
      ) {
        throw new Error("Transfer provider reconciliation is required");
      }
      return {
        transferId: existing._id,
        connectedAccountId: existing.stripeConnectedAccountId,
        amount: existing.amount,
        remainderAtoms: existing.remainderAtoms,
        currency: existing.currency,
        idempotencyKey: existing.idempotencyKey,
        correlationNonce: existing.correlationNonce,
        correlationHmac: existing.correlationHmac,
        platformAccountId: existing.platformAccountId,
        correlationState: existing.correlationState,
        metadataRepairVersion: existing.metadataRepairVersion,
        providerCreateMetadataShape: existing.providerCreateMetadataShape,
        stripeTransferId: existing.stripeTransferId,
        requestFingerprint: existing.requestFingerprint,
      };
    }
    const now = Date.now();
    const transferId = await ctx.db.insert("publisherTransfers", {
      publisherOrganizationId: args.publisherOrganizationId,
      stripeConnectedAccountId: profile.stripeConnectedAccountId,
      amount,
      amountAtoms,
      remainderAtoms,
      currency: "usd",
      idempotencyKey,
      reversedAmount: 0,
      correlationNonce: args.correlationNonce,
      platformAccountId: args.platformAccountId,
      correlationState: "local_prepared",
      metadataRepairVersion: 2,
      providerCreateMetadataShape: "correlated_v2",
      status: "created",
      createdAt: now,
      updatedAt: now,
    });
    const correlationHmac = await signTransferCorrelation(
      transferCorrelationSecret(),
      {
        publisherTransferId: transferId,
        nonce: args.correlationNonce,
        platformAccountId: args.platformAccountId,
        destination: profile.stripeConnectedAccountId,
        currency: "usd",
        amount,
      },
    );
    const requestFingerprint = await transferRequestFingerprint({
      publisherTransferId: transferId,
      publisherOrganizationId: args.publisherOrganizationId,
      destination: profile.stripeConnectedAccountId,
      amount,
      currency: "usd",
      idempotencyKey,
      correlationNonce: args.correlationNonce,
      correlationHmac,
      platformAccountId: args.platformAccountId,
    });
    await ctx.db.patch(transferId, { correlationHmac, requestFingerprint });
    await ctx.db.insert("publisherTransferDispatches", {
      transferId,
      publisherOrganizationId: args.publisherOrganizationId,
      stripeConnectedAccountId: profile.stripeConnectedAccountId,
      idempotencyKey,
      requestFingerprint,
      state: "prepared",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "transfer_allocation",
      availableDeltaAtoms: -amountAtoms,
      allocatedDeltaAtoms: amountAtoms,
      paidDeltaAtoms: 0,
      refId: `publisher:transfer:${transferId}:allocated`,
      transferId,
    });
    return {
      transferId,
      connectedAccountId: profile.stripeConnectedAccountId,
      amount,
      remainderAtoms,
      currency: "usd",
      idempotencyKey,
      correlationNonce: args.correlationNonce,
      correlationHmac,
      platformAccountId: args.platformAccountId,
      correlationState: "local_prepared" as const,
      metadataRepairVersion: 2,
      providerCreateMetadataShape: "correlated_v2" as const,
      stripeTransferId: undefined,
      requestFingerprint,
    };
  },
});

export const getPublisherTransfer = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    return transfer;
  },
});

export const getPublisherTransferReconciliation = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    const dispatch = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_transfer", (q) => q.eq("transferId", transfer._id))
      .unique();
    if (dispatch === null) {
      throw new Error("Transfer provider reconciliation journal is missing");
    }
    await requireTransferDispatchIntegrity(transfer, dispatch);
    if (dispatch.firstAttemptAt === undefined) {
      throw new Error("Transfer has no persisted provider attempt");
    }
    return { transfer, dispatch };
  },
});

async function requireTransferDispatchIntegrity(
  transfer: Doc<"publisherTransfers">,
  dispatch: Doc<"publisherTransferDispatches">,
): Promise<void> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined ||
    transfer.requestFingerprint === undefined ||
    transfer.metadataRepairVersion !== 2 ||
    transfer.providerCreateMetadataShape === undefined ||
    dispatch.transferId !== transfer._id ||
    dispatch.publisherOrganizationId !== transfer.publisherOrganizationId ||
    dispatch.stripeConnectedAccountId !== transfer.stripeConnectedAccountId ||
    dispatch.idempotencyKey !== transfer.idempotencyKey ||
    dispatch.requestFingerprint !== transfer.requestFingerprint ||
    !Number.isSafeInteger(dispatch.attemptCount) ||
    dispatch.attemptCount < 0 ||
    (dispatch.firstAttemptAt === undefined) !==
      (dispatch.safeRetryUntil === undefined) ||
    (dispatch.firstAttemptAt !== undefined &&
      dispatch.safeRetryUntil !==
        dispatch.firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS) ||
    (dispatch.attemptCount === 0 && dispatch.firstAttemptAt !== undefined) ||
    (dispatch.attemptCount > 0 && dispatch.firstAttemptAt === undefined) ||
    (dispatch.state === "leased" &&
      (dispatch.leaseToken === undefined ||
        dispatch.leaseExpiresAt === undefined)) ||
    (dispatch.state !== "leased" &&
      (dispatch.leaseToken !== undefined ||
        dispatch.leaseExpiresAt !== undefined)) ||
    (dispatch.state === "provider_verified" &&
      (dispatch.stripeTransferId === undefined ||
        transfer.stripeTransferId !== dispatch.stripeTransferId ||
        transfer.correlationState !== "provider_verified" ||
        transfer.providerMetadataVerifiedAt === undefined))
  ) {
    throw new Error("Transfer dispatch immutable facts do not match");
  }
  const expected = await transferRequestFingerprint({
    publisherTransferId: transfer._id,
    publisherOrganizationId: transfer.publisherOrganizationId,
    destination: transfer.stripeConnectedAccountId,
    amount: transfer.amount,
    currency: transfer.currency,
    idempotencyKey: transfer.idempotencyKey,
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
  });
  if (expected !== dispatch.requestFingerprint) {
    throw new Error("Transfer dispatch request fingerprint changed");
  }
}

export const claimPublisherTransferDispatch = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    const dispatch = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_transfer", (q) => q.eq("transferId", transfer._id))
      .unique();
    if (dispatch === null) {
      throw new Error("Transfer provider reconciliation is required");
    }
    await requireTransferDispatchIntegrity(transfer, dispatch);
    if (dispatch.state === "provider_reconciliation_required") {
      return {
        mode: "blocked" as const,
        reason: dispatch.reconciliationReason,
      };
    }
    if (dispatch.state === "provider_verified") {
      return {
        mode: "verified" as const,
        stripeTransferId:
          dispatch.stripeTransferId ?? transfer.stripeTransferId,
      };
    }
    const now = Date.now();
    if (dispatch.state === "leased" && (dispatch.leaseExpiresAt ?? 0) > now) {
      return { mode: "busy" as const };
    }
    const firstAttempt = dispatch.firstAttemptAt === undefined;
    const firstAttemptAt = dispatch.firstAttemptAt ?? now;
    const safeRetryUntil =
      dispatch.safeRetryUntil ?? firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS;
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(dispatch._id, {
      state: "leased",
      attemptCount: dispatch.attemptCount + 1,
      firstAttemptAt,
      lastAttemptAt: now,
      safeRetryUntil,
      leaseToken,
      leaseExpiresAt: now + STRIPE_TRANSFER_LEASE_MS,
      reconciliationReason: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(transfer._id, {
      status: transfer.status === "created" ? "pending" : transfer.status,
      attemptedAt: now,
      updatedAt: now,
    });
    return {
      mode: firstAttempt ? ("create" as const) : ("reconcile" as const),
      allowCreateAfterNoMatch: !firstAttempt && now < safeRetryUntil,
      leaseToken,
      firstAttemptAt,
      safeRetryUntil,
      transfer,
      requestFingerprint: dispatch.requestFingerprint,
    };
  },
});

export const markPublisherTransferDispatchAmbiguous = internalMutation({
  args: {
    transferId: v.id("publisherTransfers"),
    leaseToken: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const dispatch = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_transfer", (q) => q.eq("transferId", args.transferId))
      .unique();
    if (
      dispatch === null ||
      dispatch.state !== "leased" ||
      dispatch.leaseToken !== args.leaseToken
    ) {
      return;
    }
    const reason = args.reason.slice(0, 240);
    await ctx.db.patch(dispatch._id, {
      state: "ambiguous",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      reconciliationReason: reason,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.transferId, {
      status: "pending",
      failureReason: reason,
      updatedAt: Date.now(),
    });
  },
});

export const blockPublisherTransferDispatch = internalMutation({
  args: {
    transferId: v.id("publisherTransfers"),
    leaseToken: v.string(),
    reason: v.string(),
    reconciliationPasses: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    const dispatch = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_transfer", (q) => q.eq("transferId", args.transferId))
      .unique();
    if (
      dispatch === null ||
      dispatch.state !== "leased" ||
      dispatch.leaseToken !== args.leaseToken
    ) {
      return;
    }
    if (
      !Number.isSafeInteger(args.reconciliationPasses) ||
      args.reconciliationPasses < 1
    ) {
      throw new Error("Transfer reconciliation pass count is invalid");
    }
    const reason = args.reason.slice(0, 240);
    await ctx.db.patch(dispatch._id, {
      state: "provider_reconciliation_required",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      reconciliationReason: reason,
      reconciliationPasses: args.reconciliationPasses,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.transferId, {
      status: "pending",
      failureReason: reason,
      updatedAt: Date.now(),
    });
  },
});

/** Fence check must happen before admin action mutates Stripe metadata. */
export const getLegacyPublisherTransferForRepair = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("financialMigrationJobs")
      .withIndex("by_migration_key", (q) =>
        q.eq("migrationKey", FINANCE_MIGRATION_KEY),
      )
      .unique();
    if (job === null || job.status === "verified") {
      throw new Error("Legacy transfer repair requires active migration fence");
    }
    const transfer = await ctx.db.get(args.transferId);
    if (
      transfer === null ||
      transfer.correlationState !== "provider_repair_required" ||
      transfer.metadataRepairVersion !== 1 ||
      transfer.providerCreateMetadataShape === undefined ||
      transfer.correlationNonce === undefined ||
      transfer.correlationHmac === undefined ||
      transfer.platformAccountId === undefined
    ) {
      throw new Error("Legacy transfer does not require provider repair");
    }
    return transfer;
  },
});

async function markTransferDispatchProviderVerified(
  ctx: MutationCtx,
  transfer: Doc<"publisherTransfers">,
  stripeTransferId: string,
  requestFingerprint?: string,
): Promise<void> {
  const dispatch = await ctx.db
    .query("publisherTransferDispatches")
    .withIndex("by_transfer", (q) => q.eq("transferId", transfer._id))
    .unique();
  if (dispatch === null) return;
  if (
    transfer.requestFingerprint === undefined ||
    requestFingerprint !== transfer.requestFingerprint ||
    dispatch.requestFingerprint !== transfer.requestFingerprint
  ) {
    throw new Error("Stripe transfer dispatch fingerprint is invalid");
  }
  await ctx.db.patch(dispatch._id, {
    state: "provider_verified",
    stripeTransferId,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    reconciliationReason: undefined,
    updatedAt: Date.now(),
  });
}

async function applyStripeTransferProjection(
  ctx: MutationCtx,
  transfer: Doc<"publisherTransfers">,
  args: {
    stripeTransferId: string;
    amount: number;
    amountReversed: number;
    currency: string;
    destination: string;
    platformAccountId?: string;
    correlationNonce?: string;
    correlationHmac?: string;
    metadataRepairVersion?: number;
    requestFingerprint?: string;
    failed: boolean;
    failureReason?: string;
  },
): Promise<void> {
  if (
    transfer.correlationState === undefined ||
    transfer.correlationState === "provider_repair_required" ||
    (transfer.metadataRepairVersion !== 1 &&
      transfer.metadataRepairVersion !== 2) ||
    transfer.providerCreateMetadataShape === undefined
  ) {
    throw new Error("Transfer correlation migration is incomplete");
  }
  await assertStripeTransferSnapshotMatches(transfer, args);
  if (args.failed) {
    if (transfer.status === "succeeded" || transfer.status === "reversed")
      return;
    if (transfer.status !== "failed") {
      const balance = await getOrCreatePublisherBalance(
        ctx,
        transfer.publisherOrganizationId,
      );
      await adjustPublisherBalanceAggregates(ctx, balance, {
        failedAtoms: transfer.amountAtoms,
      });
    }
    await ctx.db.patch(transfer._id, {
      stripeTransferId: args.stripeTransferId,
      status: "failed",
      failureReason: args.failureReason,
      correlationState: "provider_verified",
      providerMetadataVerifiedAt: Date.now(),
      attemptedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await markTransferDispatchProviderVerified(
      ctx,
      transfer,
      args.stripeTransferId,
      args.requestFingerprint,
    );
    return;
  }

  let balance = await getOrCreatePublisherBalance(
    ctx,
    transfer.publisherOrganizationId,
  );
  if (
    transfer.status === "created" ||
    transfer.status === "pending" ||
    transfer.status === "failed"
  ) {
    const succeeded = await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "transfer_succeeded",
      availableDeltaAtoms: 0,
      allocatedDeltaAtoms: -transfer.amountAtoms,
      paidDeltaAtoms: transfer.amountAtoms,
      refId: `publisher:transfer:${transfer._id}:succeeded`,
      transferId: transfer._id,
    });
    balance = succeeded.balance;
    if (transfer.status === "failed") {
      balance = await adjustPublisherBalanceAggregates(ctx, balance, {
        failedAtoms: -transfer.amountAtoms,
      });
    }
  }

  const targetReversedAmount = Math.max(
    transfer.reversedAmount ?? 0,
    args.amountReversed,
  );
  const reversalDelta = targetReversedAmount - (transfer.reversedAmount ?? 0);
  if (reversalDelta > 0) {
    const reversalDeltaAtoms = reversalDelta * ACCOUNTING_ATOMS_PER_USD_CENT;
    await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "transfer_reversal",
      availableDeltaAtoms: reversalDeltaAtoms,
      allocatedDeltaAtoms: 0,
      paidDeltaAtoms: -reversalDeltaAtoms,
      refId: `publisher:transfer:${transfer._id}:reversed:${targetReversedAmount}`,
      transferId: transfer._id,
    });
  }
  await ctx.db.patch(transfer._id, {
    stripeTransferId: args.stripeTransferId,
    reversedAmount: targetReversedAmount,
    status: targetReversedAmount === transfer.amount ? "reversed" : "succeeded",
    failureReason: undefined,
    correlationState: "provider_verified",
    providerMetadataVerifiedAt: Date.now(),
    attemptedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await markTransferDispatchProviderVerified(
    ctx,
    transfer,
    args.stripeTransferId,
    args.requestFingerprint,
  );
}

async function assertStripeTransferSnapshotMatches(
  transfer: Doc<"publisherTransfers">,
  args: {
    stripeTransferId: string;
    amount: number;
    amountReversed: number;
    currency: string;
    destination: string;
    platformAccountId?: string;
    correlationNonce?: string;
    correlationHmac?: string;
    metadataRepairVersion?: number;
    requestFingerprint?: string;
  },
): Promise<void> {
  const v2 = transfer.metadataRepairVersion === 2;
  if (
    !Number.isSafeInteger(args.amount) ||
    !Number.isSafeInteger(args.amountReversed) ||
    args.amount !== transfer.amount ||
    transfer.amountAtoms !== transfer.amount * ACCOUNTING_ATOMS_PER_USD_CENT ||
    args.currency.toLowerCase() !== transfer.currency.toLowerCase() ||
    args.destination !== transfer.stripeConnectedAccountId ||
    args.amountReversed < 0 ||
    args.amountReversed > args.amount
  ) {
    throw new Error("Stripe transfer snapshot does not match allocation");
  }
  if (
    transfer.platformAccountId === undefined ||
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined
  ) {
    throw new Error("Legacy transfer correlation migration is pending");
  }
  if (
    args.platformAccountId !== transfer.platformAccountId ||
    args.correlationNonce !== transfer.correlationNonce ||
    args.correlationHmac !== transfer.correlationHmac ||
    transfer.metadataRepairVersion !== (v2 ? 2 : 1) ||
    args.metadataRepairVersion !== (v2 ? 2 : 1) ||
    !(await verifyTransferCorrelation(
      transferCorrelationSecret(),
      {
        publisherTransferId: transfer._id,
        nonce: transfer.correlationNonce,
        platformAccountId: transfer.platformAccountId,
        destination: transfer.stripeConnectedAccountId,
        currency: transfer.currency,
        amount: transfer.amount,
      },
      args.correlationHmac ?? "",
    ))
  ) {
    throw new Error("Stripe transfer correlation proof is invalid");
  }
  if (v2) {
    if (
      transfer.requestFingerprint === undefined ||
      args.requestFingerprint !== transfer.requestFingerprint
    ) {
      throw new Error("Stripe transfer request fingerprint is invalid");
    }
    const expectedFingerprint = await transferRequestFingerprint({
      publisherTransferId: transfer._id,
      publisherOrganizationId: transfer.publisherOrganizationId,
      destination: transfer.stripeConnectedAccountId,
      amount: transfer.amount,
      currency: transfer.currency,
      idempotencyKey: transfer.idempotencyKey,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      platformAccountId: transfer.platformAccountId,
    });
    if (expectedFingerprint !== transfer.requestFingerprint) {
      throw new Error("Local transfer request fingerprint changed");
    }
  }
  if (
    transfer.stripeTransferId !== undefined &&
    transfer.stripeTransferId !== args.stripeTransferId
  ) {
    throw new Error("Publisher transfer Stripe id changed");
  }
}

export const projectStripeTransfer = internalMutation({
  args: {
    stripeTransferId: v.string(),
    publisherTransferId: v.optional(v.string()),
    amount: v.number(),
    amountReversed: v.number(),
    currency: v.string(),
    destination: v.string(),
    platformAccountId: v.optional(v.string()),
    correlationNonce: v.optional(v.string()),
    correlationHmac: v.optional(v.string()),
    metadataRepairVersion: v.optional(v.number()),
    requestFingerprint: v.optional(v.string()),
    failed: v.boolean(),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    let transfer = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_stripe_transfer", (q) =>
        q.eq("stripeTransferId", args.stripeTransferId),
      )
      .unique();
    if (transfer === null && args.publisherTransferId !== undefined) {
      const localId = ctx.db.normalizeId(
        "publisherTransfers",
        args.publisherTransferId,
      );
      if (localId !== null) {
        const candidate = await ctx.db.get(localId);
        if (
          candidate !== null &&
          candidate.correlationState !== undefined &&
          candidate.correlationState !== "provider_repair_required" &&
          (candidate.metadataRepairVersion === 1 ||
            candidate.metadataRepairVersion === 2) &&
          candidate.correlationNonce !== undefined &&
          candidate.correlationHmac !== undefined &&
          candidate.platformAccountId !== undefined &&
          args.correlationNonce === candidate.correlationNonce &&
          args.correlationHmac === candidate.correlationHmac &&
          args.metadataRepairVersion === candidate.metadataRepairVersion &&
          args.platformAccountId === candidate.platformAccountId &&
          (candidate.metadataRepairVersion !== 2 ||
            args.requestFingerprint === candidate.requestFingerprint)
        ) {
          transfer = candidate;
        }
      }
    }
    if (transfer === null) return;
    await applyStripeTransferProjection(ctx, transfer, {
      stripeTransferId: args.stripeTransferId,
      amount: args.amount,
      amountReversed: args.amountReversed,
      currency: args.currency,
      destination: args.destination,
      platformAccountId: args.platformAccountId,
      correlationNonce: args.correlationNonce,
      correlationHmac: args.correlationHmac,
      metadataRepairVersion: args.metadataRepairVersion,
      requestFingerprint: args.requestFingerprint,
      failed: args.failed,
      failureReason: args.failureReason,
    });
  },
});

/**
 * Provider-proof bridge used only while finance migration is fenced. It may
 * attest metadata already observed at Stripe, but cannot invent or move money.
 */
export const verifyLegacyStripeTransferMetadataRepair = internalMutation({
  args: {
    transferId: v.id("publisherTransfers"),
    stripeTransferId: v.string(),
    amount: v.number(),
    amountReversed: v.number(),
    currency: v.string(),
    destination: v.string(),
    platformAccountId: v.string(),
    correlationNonce: v.string(),
    correlationHmac: v.string(),
    metadataRepairVersion: v.number(),
    requestFingerprint: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db
      .query("financialMigrationJobs")
      .withIndex("by_migration_key", (q) =>
        q.eq("migrationKey", FINANCE_MIGRATION_KEY),
      )
      .unique();
    if (job === null || job.status === "verified") {
      throw new Error("Legacy transfer repair requires active migration fence");
    }
    const transfer = await ctx.db.get(args.transferId);
    if (
      transfer === null ||
      transfer.correlationState !== "provider_repair_required" ||
      transfer.providerCreateMetadataShape === undefined
    ) {
      throw new Error("Legacy transfer does not require provider repair");
    }
    if (
      transfer.correlationNonce === undefined ||
      transfer.correlationHmac === undefined ||
      transfer.platformAccountId === undefined ||
      !Number.isSafeInteger(args.amount) ||
      !Number.isSafeInteger(args.amountReversed) ||
      args.amount !== transfer.amount ||
      args.amountReversed < 0 ||
      args.amountReversed > args.amount ||
      args.currency.toLowerCase() !== transfer.currency.toLowerCase() ||
      args.destination !== transfer.stripeConnectedAccountId ||
      args.platformAccountId !== transfer.platformAccountId ||
      args.correlationNonce !== transfer.correlationNonce ||
      args.correlationHmac !== transfer.correlationHmac ||
      args.metadataRepairVersion !== 2 ||
      (transfer.stripeTransferId !== undefined &&
        transfer.stripeTransferId !== args.stripeTransferId) ||
      !(await verifyTransferCorrelation(
        transferCorrelationSecret(),
        {
          publisherTransferId: transfer._id,
          nonce: transfer.correlationNonce,
          platformAccountId: transfer.platformAccountId,
          destination: transfer.stripeConnectedAccountId,
          currency: transfer.currency,
          amount: transfer.amount,
        },
        args.correlationHmac,
      ))
    ) {
      throw new Error("Legacy Stripe transfer provider proof is invalid");
    }
    const requestFingerprint = await transferRequestFingerprint({
      publisherTransferId: transfer._id,
      publisherOrganizationId: transfer.publisherOrganizationId,
      destination: transfer.stripeConnectedAccountId,
      amount: transfer.amount,
      currency: transfer.currency,
      idempotencyKey: transfer.idempotencyKey,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      platformAccountId: transfer.platformAccountId,
    });
    if (args.requestFingerprint !== requestFingerprint) {
      throw new Error("Legacy Stripe transfer fingerprint is invalid");
    }
    if (transfer.reversedAmount === undefined) {
      throw new Error("Migrated transfer reversal snapshot is missing");
    }
    const balance = await ctx.db
      .query("publisherBalances")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
      )
      .unique();
    if (balance === null) {
      throw new Error("Legacy transfer publisher balance is missing");
    }
    const entries = await ctx.db
      .query("publisherSettlementEntries")
      .withIndex("by_transfer_sequence", (q) =>
        q.eq("transferId", transfer._id),
      )
      .order("asc")
      .take(101);
    if (entries.length > 100) {
      throw new Error("Legacy transfer exceeds bounded ledger source cap");
    }
    const allocations = entries.filter(
      (entry) => entry.kind === "transfer_allocation",
    );
    const successes = entries.filter(
      (entry) => entry.kind === "transfer_succeeded",
    );
    const reversals = entries.filter(
      (entry) => entry.kind === "transfer_reversal",
    );
    if (
      allocations.length !== 1 ||
      allocations[0]!.publisherBalanceId !== balance._id ||
      allocations[0]!.publisherOrganizationId !==
        transfer.publisherOrganizationId ||
      allocations[0]!.availableDeltaAtoms !== -transfer.amountAtoms ||
      allocations[0]!.allocatedDeltaAtoms !== transfer.amountAtoms ||
      allocations[0]!.paidDeltaAtoms !== 0 ||
      successes.length > 1 ||
      successes.some(
        (entry) =>
          entry.publisherBalanceId !== balance._id ||
          entry.publisherOrganizationId !== transfer.publisherOrganizationId ||
          entry.availableDeltaAtoms !== 0 ||
          entry.allocatedDeltaAtoms !== -transfer.amountAtoms ||
          entry.paidDeltaAtoms !== transfer.amountAtoms,
      ) ||
      reversals.some(
        (entry) =>
          entry.publisherBalanceId !== balance._id ||
          entry.publisherOrganizationId !== transfer.publisherOrganizationId ||
          entry.availableDeltaAtoms !== -entry.paidDeltaAtoms ||
          entry.allocatedDeltaAtoms !== 0 ||
          entry.paidDeltaAtoms >= 0,
      )
    ) {
      throw new Error("Legacy transfer ledger provenance is invalid");
    }
    const ledgerReversedAtoms = reversals.reduce(
      (sum, entry) => sum - entry.paidDeltaAtoms,
      0,
    );
    const providerReversedAtoms =
      args.amountReversed * ACCOUNTING_ATOMS_PER_USD_CENT;
    if (
      !Number.isSafeInteger(ledgerReversedAtoms) ||
      providerReversedAtoms < ledgerReversedAtoms ||
      providerReversedAtoms > transfer.amountAtoms
    ) {
      throw new Error(
        "Stripe reversal snapshot conflicts with migrated transfer ledger",
      );
    }

    let currentBalance = balance;
    let writes = 1;
    if (successes.length === 0) {
      const succeeded = await appendPublisherSettlementEntry(ctx, {
        balance: currentBalance,
        kind: "transfer_succeeded",
        availableDeltaAtoms: 0,
        allocatedDeltaAtoms: -transfer.amountAtoms,
        paidDeltaAtoms: transfer.amountAtoms,
        refId: `publisher:transfer:${transfer._id}:succeeded`,
        transferId: transfer._id,
        migrationJobId: job._id,
      });
      currentBalance = succeeded.balance;
      writes += 2;
    }
    if (transfer.status === "failed") {
      currentBalance = await adjustPublisherBalanceAggregates(
        ctx,
        currentBalance,
        { failedAtoms: -transfer.amountAtoms },
        job._id,
      );
      writes += 1;
    }
    const reversalDeltaAtoms = providerReversedAtoms - ledgerReversedAtoms;
    if (reversalDeltaAtoms > 0) {
      const reversed = await appendPublisherSettlementEntry(ctx, {
        balance: currentBalance,
        kind: "transfer_reversal",
        availableDeltaAtoms: reversalDeltaAtoms,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: -reversalDeltaAtoms,
        refId: `publisher:transfer:${transfer._id}:reversed:${args.amountReversed}`,
        transferId: transfer._id,
        migrationJobId: job._id,
      });
      currentBalance = reversed.balance;
      writes += 2;
    }
    await ctx.db.patch(transfer._id, {
      stripeTransferId: args.stripeTransferId,
      reversedAmount: args.amountReversed,
      status:
        args.amountReversed === transfer.amount ? "reversed" : "succeeded",
      failureReason: undefined,
      correlationState: "provider_verified",
      providerMetadataVerifiedAt: Date.now(),
      metadataRepairVersion: 2,
      requestFingerprint,
      updatedAt: Date.now(),
    });
    const firstAttemptAt = transfer.attemptedAt ?? transfer.createdAt;
    const existingDispatch = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_transfer", (q) => q.eq("transferId", transfer._id))
      .unique();
    const dispatchPayload = {
      publisherOrganizationId: transfer.publisherOrganizationId,
      stripeConnectedAccountId: transfer.stripeConnectedAccountId,
      idempotencyKey: transfer.idempotencyKey,
      requestFingerprint,
      state: "provider_verified" as const,
      attemptCount: Math.max(existingDispatch?.attemptCount ?? 0, 1),
      firstAttemptAt,
      lastAttemptAt: existingDispatch?.lastAttemptAt ?? firstAttemptAt,
      safeRetryUntil: firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      stripeTransferId: args.stripeTransferId,
      reconciliationReason: undefined,
      reconciliationPasses: 2,
      updatedAt: Date.now(),
    };
    if (existingDispatch === null) {
      await ctx.db.insert("publisherTransferDispatches", {
        transferId: transfer._id,
        ...dispatchPayload,
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.patch(existingDispatch._id, dispatchPayload);
    }
    await ctx.db.insert("financialMigrationAudits", {
      migrationJobId: job._id,
      phase: "transfers",
      scopeRef: transfer._id,
      result: "checkpoint",
      facts: JSON.stringify({
        providerMetadata: "verified",
        stripeTransferId: args.stripeTransferId,
        providerReversedAmount: args.amountReversed,
        appendedSuccess: successes.length === 0,
        appendedReversalAtoms: reversalDeltaAtoms,
      }),
      createdAt: Date.now(),
    });
    await ctx.db.patch(job._id, {
      rowsWritten: job.rowsWritten + writes + 1,
      // Provider truth may append publisher money after final verification
      // already visited that balance. Force independent conservation replay.
      verificationState: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const projectConnectedPayout = internalMutation({
  args: {
    stripeConnectedAccountId: v.string(),
    stripePayoutId: v.string(),
    amount: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    failureCode: v.optional(v.string()),
    arrivalDate: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const existing = await ctx.db
      .query("connectedPayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", args.stripePayoutId),
      )
      .unique();
    const payload = {
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      stripePayoutId: args.stripePayoutId,
      amount: args.amount,
      currency: args.currency,
      status: args.status,
      failureCode: args.failureCode,
      arrivalDate: args.arrivalDate,
      updatedAt: Date.now(),
    } as const;
    if (existing === null) {
      await ctx.db.insert("connectedPayouts", payload);
    } else {
      await ctx.db.patch(existing._id, payload);
    }
  },
});

export type StripeTransferClient = {
  create: Stripe["transfers"]["create"];
  retrieve: Stripe["transfers"]["retrieve"];
  list: Stripe["transfers"]["list"];
};

export type StripeTransferRepairClient = StripeTransferClient & {
  update: Stripe["transfers"]["update"];
};

function transferDestination(transfer: Stripe.Transfer): string {
  return typeof transfer.destination === "string"
    ? transfer.destination
    : (transfer.destination?.id ?? "");
}

type TransferListResult = {
  rows: Stripe.Transfer[];
  pages: number;
  truncated: boolean;
};

async function listTransferWindow(
  stripe: Pick<StripeTransferClient, "list">,
  args: {
    destination: string;
    firstAttemptAt: number;
    observedThrough: number;
  },
): Promise<TransferListResult> {
  const rows: Stripe.Transfer[] = [];
  let startingAfter: string | undefined;
  let pages = 0;
  let hasMore = false;
  do {
    if (pages >= STRIPE_TRANSFER_LIST_MAX_PAGES) {
      return { rows, pages, truncated: true };
    }
    const page = await stripe.list({
      destination: args.destination,
      created: {
        gte: Math.max(0, Math.floor(args.firstAttemptAt / 1000) - 300),
        lte: Math.ceil(args.observedThrough / 1000) + 300,
      },
      limit: STRIPE_TRANSFER_LIST_PAGE_SIZE,
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    });
    pages += 1;
    rows.push(...page.data);
    hasMore = page.has_more;
    startingAfter = page.data.at(-1)?.id;
    if (hasMore && startingAfter === undefined) {
      return { rows, pages, truncated: true };
    }
  } while (hasMore);
  return { rows, pages, truncated: false };
}

type TransferReconciliationPass = {
  exactIds: string[];
  conflictIds: string[];
  pages: number;
  truncated: boolean;
};

async function classifyTransferPass(
  rows: Stripe.Transfer[],
  transfer: Doc<"publisherTransfers">,
): Promise<Omit<TransferReconciliationPass, "pages" | "truncated">> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined ||
    transfer.requestFingerprint === undefined
  ) {
    throw new Error("Transfer request fingerprint is not available");
  }
  const hmacValid = await verifyTransferCorrelation(
    transferCorrelationSecret(),
    {
      publisherTransferId: transfer._id,
      nonce: transfer.correlationNonce,
      platformAccountId: transfer.platformAccountId,
      destination: transfer.stripeConnectedAccountId,
      currency: transfer.currency,
      amount: transfer.amount,
    },
    transfer.correlationHmac,
  );
  const fingerprint = await transferRequestFingerprint({
    publisherTransferId: transfer._id,
    publisherOrganizationId: transfer.publisherOrganizationId,
    destination: transfer.stripeConnectedAccountId,
    amount: transfer.amount,
    currency: transfer.currency,
    idempotencyKey: transfer.idempotencyKey,
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
  });
  if (!hmacValid || fingerprint !== transfer.requestFingerprint) {
    throw new Error("Local transfer request proof is invalid");
  }
  const exactIds: string[] = [];
  const conflictIds: string[] = [];
  for (const row of rows) {
    const correlated =
      row.metadata.publisherTransferId === transfer._id ||
      row.metadata.requestFingerprint === transfer.requestFingerprint ||
      row.metadata.correlationHmac === transfer.correlationHmac;
    if (!correlated) continue;
    const immutableMatches =
      row.amount === transfer.amount &&
      row.currency.toLowerCase() === transfer.currency.toLowerCase() &&
      transferDestination(row) === transfer.stripeConnectedAccountId;
    const metadataMatches =
      row.metadata.publisherTransferId === transfer._id &&
      row.metadata.correlationNonce === transfer.correlationNonce &&
      row.metadata.correlationHmac === transfer.correlationHmac &&
      row.metadata.platformAccountId === transfer.platformAccountId &&
      row.metadata.metadataRepairVersion === "2" &&
      row.metadata.requestFingerprint === transfer.requestFingerprint;
    (immutableMatches && metadataMatches ? exactIds : conflictIds).push(row.id);
  }
  return {
    exactIds: [...new Set(exactIds)].sort(),
    conflictIds: [...new Set(conflictIds)].sort(),
  };
}

export type StripeTransferReconciliationResult =
  | { kind: "exact"; snapshot: Stripe.Transfer; pages: number }
  | {
      kind: "none" | "multiple" | "conflict" | "inconsistent" | "truncated";
      exactIds: string[];
      conflictIds: string[];
      pages: number;
    };

/** Two complete bounded listing passes; caller decides whether create is safe. */
export async function reconcileStripeTransferProvider(
  stripe: Pick<StripeTransferClient, "list" | "retrieve">,
  transfer: Doc<"publisherTransfers">,
  args: { firstAttemptAt: number; observedThrough: number },
): Promise<StripeTransferReconciliationResult> {
  const passes: TransferReconciliationPass[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const listed = await listTransferWindow(stripe, {
      destination: transfer.stripeConnectedAccountId,
      firstAttemptAt: args.firstAttemptAt,
      observedThrough: args.observedThrough,
    });
    const classified = await classifyTransferPass(listed.rows, transfer);
    passes.push({ ...listed, ...classified });
  }
  const [first, second] = passes as [
    TransferReconciliationPass,
    TransferReconciliationPass,
  ];
  const pages = first.pages + second.pages;
  const same =
    JSON.stringify(first.exactIds) === JSON.stringify(second.exactIds) &&
    JSON.stringify(first.conflictIds) === JSON.stringify(second.conflictIds);
  if (!same) {
    return {
      kind: "inconsistent",
      exactIds: [...new Set([...first.exactIds, ...second.exactIds])].sort(),
      conflictIds: [
        ...new Set([...first.conflictIds, ...second.conflictIds]),
      ].sort(),
      pages,
    };
  }
  if (first.truncated || second.truncated) {
    return { kind: "truncated", ...first, pages };
  }
  if (first.conflictIds.length > 0) {
    return { kind: "conflict", ...first, pages };
  }
  if (first.exactIds.length > 1) {
    return { kind: "multiple", ...first, pages };
  }
  if (first.exactIds.length === 0) {
    return { kind: "none", ...first, pages };
  }
  const snapshot = await stripe.retrieve(first.exactIds[0]!);
  const retrieved = await classifyTransferPass([snapshot], transfer);
  if (retrieved.exactIds.length !== 1 || retrieved.conflictIds.length !== 0) {
    return {
      kind: "conflict",
      exactIds: retrieved.exactIds,
      conflictIds: retrieved.conflictIds,
      pages,
    };
  }
  return { kind: "exact", snapshot, pages };
}

function assertLegacyTransferSnapshot(
  local: Doc<"publisherTransfers">,
  snapshot: Stripe.Transfer,
): void {
  if (
    snapshot.amount !== local.amount ||
    snapshot.currency.toLowerCase() !== local.currency.toLowerCase() ||
    transferDestination(snapshot) !== local.stripeConnectedAccountId ||
    snapshot.metadata.publisherTransferId !== local._id
  ) {
    throw new Error(
      "Stripe legacy transfer snapshot does not match allocation",
    );
  }
}

/**
 * Provider repair never creates money. It retrieves a persisted provider id or
 * requires one stable exact match from two complete bounded listing passes,
 * then updates metadata. Local HMAC is not proof until final retrieval agrees.
 */
export async function repairAndRetrieveStripeTransferMetadata(
  stripe: StripeTransferRepairClient,
  transfer: Doc<"publisherTransfers">,
): Promise<Stripe.Transfer> {
  if (
    transfer.correlationState !== "provider_repair_required" ||
    transfer.providerCreateMetadataShape === undefined ||
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined
  ) {
    throw new Error("Transfer does not require provider metadata repair");
  }
  let snapshot: Stripe.Transfer;
  if (transfer.stripeTransferId === undefined) {
    const passIds: string[][] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const listed = await listTransferWindow(stripe, {
        destination: transfer.stripeConnectedAccountId,
        firstAttemptAt: transfer.attemptedAt ?? transfer.createdAt,
        observedThrough: Date.now(),
      });
      if (listed.truncated) {
        throw new Error(
          "Legacy Stripe transfer listing requires provider reconciliation",
        );
      }
      const matches = listed.rows
        .filter(
          (row) =>
            row.metadata.publisherTransferId === transfer._id &&
            row.amount === transfer.amount &&
            row.currency.toLowerCase() === transfer.currency.toLowerCase() &&
            transferDestination(row) === transfer.stripeConnectedAccountId,
        )
        .map((row) => row.id)
        .sort();
      passIds.push([...new Set(matches)]);
    }
    if (
      JSON.stringify(passIds[0]) !== JSON.stringify(passIds[1]) ||
      passIds[0]?.length !== 1
    ) {
      throw new Error(
        "Legacy Stripe transfer requires explicit provider reconciliation",
      );
    }
    snapshot = await stripe.retrieve(passIds[0]![0]!);
  } else {
    snapshot = await stripe.retrieve(transfer.stripeTransferId);
  }
  assertLegacyTransferSnapshot(transfer, snapshot);

  const requestFingerprint = await transferRequestFingerprint({
    publisherTransferId: transfer._id,
    publisherOrganizationId: transfer.publisherOrganizationId,
    destination: transfer.stripeConnectedAccountId,
    amount: transfer.amount,
    currency: transfer.currency,
    idempotencyKey: transfer.idempotencyKey,
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
  });
  const expected = {
    publisherTransferId: String(transfer._id),
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
    metadataRepairVersion: "2",
    requestFingerprint,
  };
  const conflicts = Object.entries(expected).some(
    ([key, value]) =>
      snapshot.metadata[key] !== undefined && snapshot.metadata[key] !== value,
  );
  if (conflicts) {
    throw new Error(
      "Stripe transfer contains conflicting correlation metadata",
    );
  }
  const complete = Object.entries(expected).every(
    ([key, value]) => snapshot.metadata[key] === value,
  );
  if (!complete) {
    await stripe.update(
      snapshot.id,
      { metadata: expected },
      {
        idempotencyKey: `publisher-transfer-metadata-repair:v2:${snapshot.id}`,
      },
    );
    snapshot = await stripe.retrieve(snapshot.id);
  }
  assertLegacyTransferSnapshot(transfer, snapshot);
  if (
    Object.entries(expected).some(
      ([key, value]) => snapshot.metadata[key] !== value,
    )
  ) {
    throw new Error("Stripe transfer metadata repair was not observed");
  }
  return snapshot;
}

export async function createAndRetrieveStripeTransfer(
  stripe: Pick<StripeTransferClient, "create" | "retrieve">,
  transfer: Doc<"publisherTransfers">,
  authorization?: {
    leaseToken: string;
    firstAttemptAt: number;
    safeRetryUntil: number;
    requestFingerprint: string;
    nowMs?: number;
  },
): Promise<Stripe.Transfer> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined ||
    transfer.requestFingerprint === undefined ||
    (transfer.correlationState !== "local_prepared" &&
      transfer.correlationState !== "provider_verified") ||
    transfer.metadataRepairVersion !== 2 ||
    transfer.providerCreateMetadataShape !== "correlated_v2"
  ) {
    throw new Error("Transfer correlation migration is incomplete");
  }
  if (transfer.stripeTransferId !== undefined) {
    return await stripe.retrieve(transfer.stripeTransferId);
  }
  const now = authorization?.nowMs ?? Date.now();
  if (
    authorization === undefined ||
    authorization.leaseToken.trim() === "" ||
    authorization.requestFingerprint !== transfer.requestFingerprint ||
    !Number.isSafeInteger(authorization.firstAttemptAt) ||
    !Number.isSafeInteger(authorization.safeRetryUntil) ||
    authorization.safeRetryUntil !==
      authorization.firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS ||
    now < authorization.firstAttemptAt ||
    now >= authorization.safeRetryUntil
  ) {
    throw new Error("Active safe-window transfer dispatch lease required");
  }
  const expectedFingerprint = await transferRequestFingerprint({
    publisherTransferId: transfer._id,
    publisherOrganizationId: transfer.publisherOrganizationId,
    destination: transfer.stripeConnectedAccountId,
    amount: transfer.amount,
    currency: transfer.currency,
    idempotencyKey: transfer.idempotencyKey,
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
  });
  if (expectedFingerprint !== transfer.requestFingerprint) {
    throw new Error("Transfer create request fingerprint changed");
  }
  const created = await stripe.create(
    {
      amount: transfer.amount,
      currency: transfer.currency,
      destination: transfer.stripeConnectedAccountId,
      metadata: {
        publisherTransferId: transfer._id,
        correlationNonce: transfer.correlationNonce,
        correlationHmac: transfer.correlationHmac,
        platformAccountId: transfer.platformAccountId,
        metadataRepairVersion: "2",
        requestFingerprint: transfer.requestFingerprint,
      },
    },
    { idempotencyKey: transfer.idempotencyKey },
  );
  return await stripe.retrieve(created.id);
}

export async function transferToStripe(
  ctx: ActionCtx,
  transfer: { _id: Id<"publisherTransfers"> },
): Promise<void> {
  const claim = await ctx.runMutation(
    internal.payouts.claimPublisherTransferDispatch,
    { transferId: transfer._id },
  );
  if (claim.mode === "verified") return;
  if (claim.mode === "busy") {
    throw new Error("Transfer dispatch is already leased");
  }
  if (claim.mode === "blocked") {
    throw new Error(
      claim.reason ?? "Transfer provider reconciliation is required",
    );
  }
  const local = claim.transfer;
  const stripe = stripeClient().transfers;
  try {
    let stripeTransfer: Stripe.Transfer;
    if (claim.mode === "create") {
      stripeTransfer = await createAndRetrieveStripeTransfer(stripe, local, {
        leaseToken: claim.leaseToken,
        firstAttemptAt: claim.firstAttemptAt,
        safeRetryUntil: claim.safeRetryUntil,
        requestFingerprint: claim.requestFingerprint,
      });
    } else {
      const reconciliation = await reconcileStripeTransferProvider(
        stripe,
        local,
        {
          firstAttemptAt: claim.firstAttemptAt,
          observedThrough: Date.now(),
        },
      );
      if (reconciliation.kind === "exact") {
        stripeTransfer = reconciliation.snapshot;
      } else if (
        reconciliation.kind === "none" &&
        claim.allowCreateAfterNoMatch &&
        Date.now() < claim.safeRetryUntil
      ) {
        stripeTransfer = await createAndRetrieveStripeTransfer(stripe, local, {
          leaseToken: claim.leaseToken,
          firstAttemptAt: claim.firstAttemptAt,
          safeRetryUntil: claim.safeRetryUntil,
          requestFingerprint: claim.requestFingerprint,
        });
      } else {
        const reason =
          reconciliation.kind === "none"
            ? "No exact provider transfer found outside safe retry window"
            : `Provider transfer reconciliation ${reconciliation.kind}`;
        await ctx.runMutation(internal.payouts.blockPublisherTransferDispatch, {
          transferId: local._id,
          leaseToken: claim.leaseToken,
          reason,
          reconciliationPasses: 2,
        });
        throw new Error(reason);
      }
    }
    await ctx.runMutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: stripeTransfer.id,
      publisherTransferId:
        stripeTransfer.metadata.publisherTransferId ?? local._id,
      amount: stripeTransfer.amount,
      amountReversed: stripeTransfer.amount_reversed,
      currency: stripeTransfer.currency,
      destination:
        typeof stripeTransfer.destination === "string"
          ? stripeTransfer.destination
          : (stripeTransfer.destination?.id ?? ""),
      platformAccountId: stripeTransfer.metadata.platformAccountId,
      correlationNonce: stripeTransfer.metadata.correlationNonce,
      correlationHmac: stripeTransfer.metadata.correlationHmac,
      metadataRepairVersion:
        stripeTransfer.metadata.metadataRepairVersion === undefined
          ? undefined
          : Number(stripeTransfer.metadata.metadataRepairVersion),
      requestFingerprint: stripeTransfer.metadata.requestFingerprint,
      failed: false,
      failureReason: undefined,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "Stripe transfer dispatch outcome is ambiguous";
    await ctx.runMutation(
      internal.payouts.markPublisherTransferDispatchAmbiguous,
      {
        transferId: local._id,
        leaseToken: claim.leaseToken,
        reason: message,
      },
    );
    throw error;
  }
}

export const resumePublisherTransferDispatch = internalAction({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args): Promise<void> => {
    try {
      await transferToStripe(ctx, { _id: args.transferId });
    } catch (error) {
      console.error("publisher transfer recovery paused", {
        transferId: args.transferId,
        message:
          error instanceof Error ? error.message : "unknown transfer error",
      });
    }
  },
});

/** Recovers scheduler/action crash windows without authorizing unsafe create. */
export const recoverPublisherTransferDispatches = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const prepared = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_state_updated", (q) => q.eq("state", "prepared"))
      .take(50);
    const ambiguous = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_state_updated", (q) => q.eq("state", "ambiguous"))
      .take(50);
    const leased = await ctx.db
      .query("publisherTransferDispatches")
      .withIndex("by_state_updated", (q) => q.eq("state", "leased"))
      .filter((q) => q.lte(q.field("leaseExpiresAt"), now))
      .take(50);
    const transferIds = new Set<Id<"publisherTransfers">>();
    for (const dispatch of [...prepared, ...ambiguous, ...leased]) {
      if (transferIds.has(dispatch.transferId)) continue;
      transferIds.add(dispatch.transferId);
      await ctx.scheduler.runAfter(
        0,
        internal.payouts.resumePublisherTransferDispatch,
        { transferId: dispatch.transferId },
      );
    }
    return { scheduled: transferIds.size };
  },
});

export const initiatePublisherTransfer = action({
  args: {},
  handler: async (ctx): Promise<{ transferId: Id<"publisherTransfers"> }> => {
    const claims = await requireIdentity(ctx);
    requireOrgAdmin(claims);
    const clerkOrgId = claims.orgId;
    if (clerkOrgId === undefined) {
      throw new Error("Active organization required");
    }

    const profile = await ctx.runMutation(
      internal.payouts.getConnectProfileForActiveOrg,
      { clerkOrgId },
    );
    await ctx.runMutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: profile.organizationId,
    });
    const prepared = await ctx.runMutation(
      internal.payouts.preparePublisherTransfer,
      {
        publisherOrganizationId: profile.organizationId,
        correlationNonce: randomCorrelationNonce(),
        platformAccountId: stripePlatformAccountId(),
      },
    );
    await transferToStripe(ctx, { _id: prepared.transferId });
    return { transferId: prepared.transferId };
  },
});

export const getPayoutState = query({
  args: {},
  handler: async (ctx) => {
    await assertFinanceMigrationAllowsRuntime(ctx);
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined)
      throw new Error("Active organization required");
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (organization === null || organization.archivedAt !== undefined)
      throw new Error("Active organization is not provisioned");
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organization._id),
      )
      .unique();
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", organization._id),
      )
      .order("desc")
      .take(100);
    const publisherBalance = await ctx.db
      .query("publisherBalances")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", organization._id),
      )
      .unique();
    if (publisherBalance === null) {
      if (earnings.length > 0) {
        throw new Error("Publisher finance migration is not verified");
      }
    } else {
      assertPublisherBalanceReady(publisherBalance);
    }
    const transfers = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", organization._id),
      )
      .order("desc")
      .take(100);
    if (publisherBalance === null && transfers.length > 0) {
      throw new Error("Publisher finance migration is not verified");
    }
    for (const transfer of transfers) {
      const dispatch = await ctx.db
        .query("publisherTransferDispatches")
        .withIndex("by_transfer", (q) => q.eq("transferId", transfer._id))
        .unique();
      if (
        transfer.reversedAmount === undefined ||
        transfer.correlationNonce === undefined ||
        transfer.correlationHmac === undefined ||
        transfer.platformAccountId === undefined ||
        transfer.correlationState === undefined ||
        transfer.correlationState === "provider_repair_required" ||
        transfer.metadataRepairVersion !== 2 ||
        transfer.providerCreateMetadataShape === undefined ||
        transfer.requestFingerprint === undefined ||
        dispatch === null ||
        (transfer.correlationState === "provider_verified" &&
          transfer.providerMetadataVerifiedAt === undefined)
      ) {
        throw new Error("Transfer correlation migration is incomplete");
      }
      await requireTransferDispatchIntegrity(transfer, dispatch);
    }
    const payouts =
      profile?.stripeConnectedAccountId === undefined
        ? []
        : await ctx.db
            .query("connectedPayouts")
            .withIndex("by_connected_account", (q) =>
              q.eq(
                "stripeConnectedAccountId",
                profile.stripeConnectedAccountId!,
              ),
            )
            .order("desc")
            .take(100);
    const totals =
      publisherBalance === null
        ? {
            pendingRisk: 0,
            available: 0,
            allocated: 0,
            transferred: 0,
            reversed: 0,
            failed: 0,
          }
        : {
            pendingRisk: atomsToCredits(publisherBalance.pendingRiskAtoms),
            available: atomsToCredits(publisherBalance.availableAtoms),
            allocated: atomsToCredits(publisherBalance.allocatedAtoms),
            transferred: atomsToCredits(publisherBalance.paidAtoms),
            reversed: atomsToCredits(publisherBalance.reversedAtoms),
            failed: atomsToCredits(publisherBalance.failedAtoms),
          };
    const profileStatus: ConnectProfileStatus =
      profile === null || profile.stripeConnectedAccountId === undefined
        ? "not_started"
        : profile.payoutsEnabled
          ? "enabled"
          : profile.disabledReason !== undefined
            ? "restricted"
            : "incomplete";
    return {
      profile: {
        status: profileStatus,
        disabledReason: profile?.disabledReason,
        requirements: profile?.requirements ?? [],
      },
      earnings: {
        ...totals,
        minimumPayoutCredits: atomsToCredits(PUBLISHER_MINIMUM_PAYOUT_ATOMS),
        canTransfer:
          (publisherBalance?.availableAtoms ?? 0) >=
          PUBLISHER_MINIMUM_PAYOUT_ATOMS,
        rows: earnings.map((earning) => ({
          id: earning._id,
          grossCredits: earning.grossCredits,
          platformFeeCredits: atomsToCredits(earning.platformFeeAtoms),
          netCredits: atomsToCredits(earning.publisherNetAtoms),
          clawedBackCredits: atomsToCredits(earning.clawedBackAtoms),
          availableAt: earning.availableAt,
          status: earning.status,
          createdAt: earning.createdAt,
        })),
      },
      transfers: transfers.map((transfer) => ({
        id: transfer._id,
        amount: transfer.amount,
        currency: transfer.currency,
        status: transfer.status,
        failureReason: transfer.failureReason,
        stripeTransferId: transfer.stripeTransferId,
        createdAt: transfer.createdAt,
        updatedAt: transfer.updatedAt,
      })),
      payouts: payouts.map((payout) => ({
        id: payout._id,
        amount: payout.amount,
        currency: payout.currency,
        status: payout.status,
        failureCode: payout.failureCode,
        arrivalDate: payout.arrivalDate,
        updatedAt: payout.updatedAt,
      })),
    };
  },
});
