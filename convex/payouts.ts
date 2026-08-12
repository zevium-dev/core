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
import { requireIdentity } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import {
  adjustPublisherBalanceAggregates,
  appendPublisherSettlementEntry,
  getOrCreatePublisherBalance,
  releasePublisherEarning,
} from "./lib/publisherLedger";
import { stripeClient } from "./billing";

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

function activeClerkOrgId(identity: unknown): string {
  if (identity === null || typeof identity !== "object") {
    throw new Error("Not authenticated");
  }
  const raw = identity as Record<string, unknown>;
  const orgId =
    typeof raw.org_id === "string"
      ? raw.org_id
      : typeof raw.orgId === "string"
        ? raw.orgId
        : undefined;
  if (orgId === undefined || orgId.trim() === "") {
    throw new Error("Active organization required");
  }
  return orgId;
}

async function requireActiveClerkOrgAdminInAction(
  ctx: ActionCtx,
): Promise<{ clerkOrgId: string; identity: Record<string, unknown> }> {
  const identity = await ctx.auth.getUserIdentity();
  const clerkOrgId = activeClerkOrgId(identity);
  const raw = identity as Record<string, unknown>;
  const role =
    typeof raw.org_role === "string"
      ? raw.org_role
      : typeof raw.orgRole === "string"
        ? raw.orgRole
        : undefined;
  if (role !== "org:admin" && role !== "org:owner") {
    throw new Error("Org admin or owner role required");
  }
  return { clerkOrgId, identity: raw };
}

/** Test seam for deterministic account-link creation. */
export type ConnectOnboardingClient = {
  accountsV2: {
    create: (
      params: Stripe.V2.Core.AccountCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Pick<Stripe.V2.Core.Account, "id">>;
  };
  accountLinksV2: {
    create: (
      params: Stripe.V2.Core.AccountLinkCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<
      Pick<Stripe.V2.Core.AccountLink, "account" | "livemode" | "url">
    >;
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
  const link = await stripe.accountLinksV2.create({
    account: connectedAccountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        collection_options: {
          fields: "eventually_due",
          future_requirements: "include",
        },
        refresh_url: args.refreshUrl,
        return_url: args.returnUrl,
      },
    },
  });
  if (link.account !== connectedAccountId)
    throw new Error("Stripe Account Link changed connected account");
  if (
    link.livemode !== false &&
    process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
  )
    throw new Error("Stripe returned a live Account Link in test mode");
  const hostedUrl = new URL(link.url);
  if (
    hostedUrl.protocol !== "https:" ||
    (hostedUrl.hostname !== "connect.stripe.com" &&
      !hostedUrl.hostname.endsWith(".connect.stripe.com")) ||
    hostedUrl.username !== "" ||
    hostedUrl.password !== ""
  ) {
    throw new Error("Stripe returned an invalid hosted onboarding URL");
  }
  return { connectedAccountId, url: link.url };
}

export const getConnectProfileForActiveOrg = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
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
    const country = args.country?.trim().toUpperCase() ?? null;
    const { clerkOrgId, identity } =
      await requireActiveClerkOrgAdminInAction(ctx);
    const contactEmail =
      typeof identity.email === "string" ? identity.email.trim() : "";
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
        accountLinksV2: stripe.v2.core.accountLinks,
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
    await ctx.db.patch(transferId, { correlationHmac });
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
    };
  },
});

export const getPublisherTransfer = internalMutation({
  args: { transferId: v.id("publisherTransfers") },
  handler: async (ctx, args) => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    return transfer;
  },
});

export const markPublisherTransferSucceeded = internalMutation({
  args: {
    transferId: v.id("publisherTransfers"),
    stripeTransferId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    await applyStripeTransferProjection(ctx, transfer, {
      stripeTransferId: args.stripeTransferId,
      amount: transfer.amount,
      amountReversed: transfer.reversedAmount ?? 0,
      currency: transfer.currency,
      destination: transfer.stripeConnectedAccountId,
      platformAccountId: transfer.platformAccountId,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      failed: false,
    });
  },
});

export const markPublisherTransferFailed = internalMutation({
  args: { transferId: v.id("publisherTransfers"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    if (transfer.status === "succeeded" || transfer.status === "reversed")
      return;
    const now = Date.now();
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
      status: "failed",
      failureReason: args.reason.slice(0, 240),
      attemptedAt: now,
      updatedAt: now,
    });
    const org = await ctx.db.get(transfer.publisherOrganizationId);
    if (org !== null) {
      await createNotification(ctx, {
        clerkOrgId: org.clerkOrgId,
        kind: "transfer_failed",
        title: "Publisher transfer failed",
        body: "Your publisher transfer could not be completed. The platform will retry it safely.",
        refId: `transfer_failed:${transfer._id}`,
      });
    }
  },
});

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
    failed: boolean;
    failureReason?: string;
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(args.amount) ||
    !Number.isSafeInteger(args.amountReversed) ||
    args.amount !== transfer.amount ||
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
  if (
    transfer.stripeTransferId !== undefined &&
    transfer.stripeTransferId !== args.stripeTransferId
  ) {
    throw new Error("Publisher transfer Stripe id changed");
  }
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
      attemptedAt: Date.now(),
      updatedAt: Date.now(),
    });
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
    attemptedAt: Date.now(),
    updatedAt: Date.now(),
  });
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
    failed: v.boolean(),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
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
          candidate.correlationNonce !== undefined &&
          candidate.correlationHmac !== undefined &&
          candidate.platformAccountId !== undefined &&
          args.correlationNonce === candidate.correlationNonce &&
          args.correlationHmac === candidate.correlationHmac &&
          args.platformAccountId === candidate.platformAccountId
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
      failed: args.failed,
      failureReason: args.failureReason,
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
};

export async function createAndRetrieveStripeTransfer(
  stripe: StripeTransferClient,
  transfer: {
    _id: Id<"publisherTransfers">;
    stripeConnectedAccountId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    correlationNonce?: string;
    correlationHmac?: string;
    platformAccountId?: string;
  },
): Promise<Stripe.Transfer> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined
  ) {
    throw new Error("Transfer correlation migration is incomplete");
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
      },
    },
    { idempotencyKey: transfer.idempotencyKey },
  );
  return await stripe.retrieve(created.id);
}

export async function transferToStripe(
  ctx: ActionCtx,
  transfer: {
    _id: Id<"publisherTransfers">;
    stripeConnectedAccountId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    correlationNonce?: string;
    correlationHmac?: string;
    platformAccountId?: string;
  },
): Promise<void> {
  try {
    const stripeTransfer = await createAndRetrieveStripeTransfer(
      stripeClient().transfers,
      transfer,
    );
    await ctx.runMutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: stripeTransfer.id,
      publisherTransferId:
        stripeTransfer.metadata.publisherTransferId ?? transfer._id,
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
      failed: false,
      failureReason: undefined,
    });
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message.slice(0, 240)
        : "Stripe transfer failed";
    await ctx.runMutation(internal.payouts.markPublisherTransferFailed, {
      transferId: transfer._id,
      reason,
    });
    throw error;
  }
}

export const initiatePublisherTransfer = action({
  args: {},
  handler: async (ctx): Promise<{ transferId: Id<"publisherTransfers"> }> => {
    const { clerkOrgId } = await requireActiveClerkOrgAdminInAction(ctx);
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
    await transferToStripe(ctx, {
      _id: prepared.transferId,
      stripeConnectedAccountId: prepared.connectedAccountId,
      amount: prepared.amount,
      currency: prepared.currency,
      idempotencyKey: prepared.idempotencyKey,
      correlationNonce: prepared.correlationNonce,
      correlationHmac: prepared.correlationHmac,
      platformAccountId: prepared.platformAccountId,
    });
    return { transferId: prepared.transferId };
  },
});

export const getPayoutState = query({
  args: {},
  handler: async (ctx) => {
    const claims = await requireIdentity(ctx);
    if (claims.orgId === undefined)
      throw new Error("Active organization required");
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", claims.orgId!))
      .unique();
    if (organization === null)
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
    const transfers = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", organization._id),
      )
      .order("desc")
      .take(100);
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
    const totals = {
      pendingRisk: atomsToCredits(publisherBalance?.pendingRiskAtoms ?? 0),
      available: atomsToCredits(publisherBalance?.availableAtoms ?? 0),
      allocated: atomsToCredits(publisherBalance?.allocatedAtoms ?? 0),
      transferred: atomsToCredits(publisherBalance?.paidAtoms ?? 0),
      reversed: atomsToCredits(publisherBalance?.reversedAtoms ?? 0),
      failed: atomsToCredits(publisherBalance?.failedAtoms ?? 0),
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
