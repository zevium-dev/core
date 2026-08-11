import Stripe from "stripe";
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  ACCOUNTING_ATOMS_PER_USD_CENT,
  PUBLISHER_MINIMUM_PAYOUT_ATOMS,
  atomsToCredits,
  atomsToUsdCents,
} from "./accounting";
import { requireIdentity } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import {
  appendPublisherSettlementEntry,
  getOrCreatePublisherBalance,
  releasePublisherEarning,
} from "./lib/publisherLedger";
import { stripeClient } from "./billing";

export type ConnectProfileStatus =
  "not_started" | "incomplete" | "restricted" | "enabled";

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

async function requireActiveClerkOrgInAction(ctx: ActionCtx): Promise<string> {
  return activeClerkOrgId(await ctx.auth.getUserIdentity());
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
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (organization === null || organization.archivedAt !== undefined)
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
    const identity = await ctx.auth.getUserIdentity();
    const clerkOrgId = activeClerkOrgId(identity);
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
  handler: async (ctx, args): Promise<void> => {
    const now = Date.now();
    const pending = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("status"), "pending_risk"))
      .collect();
    for (const earning of pending) {
      if (earning.availableAt <= now) {
        await releasePublisherEarning(ctx, earning);
      }
    }
  },
});

export const preparePublisherTransfer = internalMutation({
  args: { publisherOrganizationId: v.id("organizations") },
  handler: async (ctx, args) => {
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
    const priorTransfers = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId),
      )
      .order("desc")
      .take(20);
    const retry = priorTransfers.find(
      (transfer) =>
        transfer.status === "created" ||
        transfer.status === "pending" ||
        transfer.status === "failed",
    );
    if (retry !== undefined) {
      return {
        transferId: retry._id,
        connectedAccountId: retry.stripeConnectedAccountId,
        amount: retry.amount,
        remainderAtoms: retry.remainderAtoms,
        currency: retry.currency,
        idempotencyKey: retry.idempotencyKey,
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
      status: "created",
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
    if (transfer.status === "succeeded") {
      if (transfer.stripeTransferId !== args.stripeTransferId) {
        throw new Error("Publisher transfer Stripe id changed");
      }
      return;
    }
    if (transfer.status === "reversed") return;
    const now = Date.now();
    const balance = await getOrCreatePublisherBalance(
      ctx,
      transfer.publisherOrganizationId,
    );
    await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "transfer_succeeded",
      availableDeltaAtoms: 0,
      allocatedDeltaAtoms: -transfer.amountAtoms,
      paidDeltaAtoms: transfer.amountAtoms,
      refId: `publisher:transfer:${transfer._id}:succeeded`,
      transferId: transfer._id,
    });
    await ctx.db.patch(transfer._id, {
      stripeTransferId: args.stripeTransferId,
      status: "succeeded",
      failureReason: undefined,
      attemptedAt: now,
      updatedAt: now,
    });
  },
});

export const markPublisherTransferFailed = internalMutation({
  args: { transferId: v.id("publisherTransfers"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) throw new Error("Publisher transfer not found");
    const now = Date.now();
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

export const projectStripeTransfer = internalMutation({
  args: {
    stripeTransferId: v.string(),
    state: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("reversed"),
    ),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db
      .query("publisherTransfers")
      .withIndex("by_stripe_transfer", (q) =>
        q.eq("stripeTransferId", args.stripeTransferId),
      )
      .unique();
    if (transfer === null) return;
    if (transfer.status === args.state) return;
    if (
      (transfer.status === "succeeded" || transfer.status === "reversed") &&
      args.state === "failed"
    ) {
      return;
    }
    if (transfer.status === "reversed" && args.state === "succeeded") return;
    const now = Date.now();
    const balance = await getOrCreatePublisherBalance(
      ctx,
      transfer.publisherOrganizationId,
    );
    if (args.state === "succeeded") {
      await appendPublisherSettlementEntry(ctx, {
        balance,
        kind: "transfer_succeeded",
        availableDeltaAtoms: 0,
        allocatedDeltaAtoms: -transfer.amountAtoms,
        paidDeltaAtoms: transfer.amountAtoms,
        refId: `publisher:transfer:${transfer._id}:succeeded`,
        transferId: transfer._id,
      });
    } else if (args.state === "reversed") {
      await appendPublisherSettlementEntry(ctx, {
        balance,
        kind: "transfer_reversal",
        availableDeltaAtoms: transfer.amountAtoms,
        allocatedDeltaAtoms:
          transfer.status === "succeeded" ? 0 : -transfer.amountAtoms,
        paidDeltaAtoms:
          transfer.status === "succeeded" ? -transfer.amountAtoms : 0,
        refId: `publisher:transfer:${transfer._id}:reversed`,
        transferId: transfer._id,
      });
    }
    await ctx.db.patch(transfer._id, {
      status: args.state,
      failureReason: args.failureReason,
      updatedAt: now,
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

async function transferToStripe(
  ctx: ActionCtx,
  transfer: {
    _id: Id<"publisherTransfers">;
    stripeConnectedAccountId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
  },
): Promise<void> {
  try {
    const stripeTransfer = await stripeClient().transfers.create(
      {
        amount: transfer.amount,
        currency: transfer.currency,
        destination: transfer.stripeConnectedAccountId,
        metadata: { publisherTransferId: transfer._id },
      },
      { idempotencyKey: transfer.idempotencyKey },
    );
    await ctx.runMutation(internal.payouts.markPublisherTransferSucceeded, {
      transferId: transfer._id,
      stripeTransferId: stripeTransfer.id,
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
    const clerkOrgId = await requireActiveClerkOrgInAction(ctx);
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
      },
    );
    await transferToStripe(ctx, {
      _id: prepared.transferId,
      stripeConnectedAccountId: prepared.connectedAccountId,
      amount: prepared.amount,
      currency: prepared.currency,
      idempotencyKey: prepared.idempotencyKey,
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
      pendingRisk: 0,
      available: atomsToCredits(publisherBalance?.availableAtoms ?? 0),
      allocated: atomsToCredits(publisherBalance?.allocatedAtoms ?? 0),
      transferred: atomsToCredits(publisherBalance?.paidAtoms ?? 0),
      reversed: 0,
      failed: 0,
    };
    for (const earning of earnings) {
      if (earning.status === "pending_risk")
        totals.pendingRisk += atomsToCredits(
          earning.publisherNetAtoms - earning.clawedBackAtoms,
        );
      totals.reversed += atomsToCredits(earning.clawedBackAtoms);
    }
    totals.failed = atomsToCredits(
      transfers
        .filter((transfer) => transfer.status === "failed")
        .reduce((sum, transfer) => sum + transfer.amountAtoms, 0),
    );
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
