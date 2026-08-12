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
import { CREDITS_PER_USD_CENT, creditsToUsdCents } from "./accounting";
import { requireIdentity, requireOrgAdmin } from "./lib/auth";
import { createNotification } from "./lib/notifications";
import { stripeClient } from "./billing";

export type ConnectProfileStatus =
  "not_started" | "incomplete" | "restricted" | "enabled";

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
        await ctx.db.patch(earning._id, {
          status: "available",
          updatedAt: now,
        });
      }
    }
  },
});

/**
 * Build a Stripe-safe idempotency key for a publisher transfer.
 *
 * Joining earning ids directly exceeds Stripe's 255-character idempotency key
 * limit at ~9 earnings (each Convex id is ~32 chars + separator), causing
 * every non-trivial payout to fail. Instead, hash the sorted earning ids with
 * SHA-256 (64 hex chars) and prefix with `payout_` for a deterministic,
 * length-capped key. Same earnings → same key, so retries dedupe.
 */
async function publisherTransferIdempotencyKey(
  publisherOrganizationId: Id<"organizations">,
  earnings: { _id: Id<"publisherEarnings"> }[],
): Promise<string> {
  const payload = `${publisherOrganizationId}:${earnings
    .map((earning) => earning._id)
    .sort()
    .join(",")}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `payout_${hex}`;
}

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
        remainderCredits: retry.remainderCredits,
        currency: retry.currency,
        idempotencyKey: retry.idempotencyKey,
      };
    }
    const now = Date.now();
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", args.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("status"), "available"))
      .collect();
    const carriedCredits = priorTransfers[0]?.remainderCredits ?? 0;
    const credits = earnings.reduce(
      (total, earning) => total + earning.netCredits,
      carriedCredits,
    );
    const amount = creditsToUsdCents(credits);
    if (amount <= 0) throw new Error("Available earnings are below one cent");
    const remainderCredits = credits % CREDITS_PER_USD_CENT;
    const idempotencyKey = await publisherTransferIdempotencyKey(
      args.publisherOrganizationId,
      earnings,
    );
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
        remainderCredits: existing.remainderCredits,
        currency: existing.currency,
        idempotencyKey: existing.idempotencyKey,
      };
    }
    const transferId = await ctx.db.insert("publisherTransfers", {
      publisherOrganizationId: args.publisherOrganizationId,
      stripeConnectedAccountId: profile.stripeConnectedAccountId,
      amount,
      remainderCredits,
      currency: "usd",
      idempotencyKey,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });
    for (const earning of earnings) {
      await ctx.db.patch(earning._id, {
        status: "allocated_to_transfer",
        transferId,
        updatedAt: now,
      });
    }
    return {
      transferId,
      connectedAccountId: profile.stripeConnectedAccountId,
      amount,
      remainderCredits,
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
    const now = Date.now();
    await ctx.db.patch(transfer._id, {
      stripeTransferId: args.stripeTransferId,
      status: "succeeded",
      failureReason: undefined,
      attemptedAt: now,
      updatedAt: now,
    });
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("transferId"), transfer._id))
      .collect();
    for (const earning of earnings) {
      await ctx.db.patch(earning._id, {
        status: "transferred",
        updatedAt: now,
      });
    }
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
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("transferId"), transfer._id))
      .collect();
    for (const earning of earnings) {
      await ctx.db.patch(earning._id, { status: "failed", updatedAt: now });
    }
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
    const now = Date.now();
    await ctx.db.patch(transfer._id, {
      status: args.state,
      failureReason: args.failureReason,
      updatedAt: now,
    });
    const earnings = await ctx.db
      .query("publisherEarnings")
      .withIndex("by_publisher", (q) =>
        q.eq("publisherOrganizationId", transfer.publisherOrganizationId),
      )
      .filter((q) => q.eq(q.field("transferId"), transfer._id))
      .collect();
    const earningStatus =
      args.state === "succeeded" ? "transferred" : args.state;
    for (const earning of earnings) {
      await ctx.db.patch(earning._id, {
        status: earningStatus,
        updatedAt: now,
      });
    }
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
      available: 0,
      allocated: 0,
      transferred: 0,
      reversed: 0,
      failed: 0,
    };
    for (const earning of earnings) {
      if (earning.status === "pending_risk")
        totals.pendingRisk += earning.netCredits;
      else if (earning.status === "available")
        totals.available += earning.netCredits;
      else if (earning.status === "allocated_to_transfer")
        totals.allocated += earning.netCredits;
      else if (earning.status === "transferred")
        totals.transferred += earning.netCredits;
      else if (earning.status === "reversed")
        totals.reversed += earning.netCredits;
      else totals.failed += earning.netCredits;
    }
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
        rows: earnings.map((earning) => ({
          id: earning._id,
          grossCredits: earning.grossCredits,
          platformFeeCredits: earning.platformFeeCredits,
          netCredits: earning.netCredits,
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
