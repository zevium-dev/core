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

const CONNECT_ACCOUNT_RECONCILIATION_LIMIT = 1_000;
const STRIPE_V2_IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const CONNECT_LINK_RETRY_WINDOW_MS = 4 * 60 * 1_000;
const CONNECT_LINK_MIN_VALIDITY_MS = 30 * 1_000;
const CONNECT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;

type ConnectedAccountExpectation = {
  accountId?: string;
  clerkOrgId: string;
  organizationId: string;
  expectedLivemode: boolean;
  operationId?: string;
  country?: string;
};

/** Narrow provider seam. Params stay pinned to stripe-node's Accounts v2 types. */
export type ConnectOnboardingClient = {
  accountsV2: {
    create: (
      params: Stripe.V2.Core.AccountCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Stripe.V2.Core.Account>;
    retrieve: (
      id: string,
      params?: Stripe.V2.Core.AccountRetrieveParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Stripe.V2.Core.Account>;
    listRecipientAccounts: (limit: number) => Promise<Stripe.V2.Core.Account[]>;
  };
  accountLinksV2: {
    create: (
      params: Stripe.V2.Core.AccountLinkCreateParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Stripe.V2.Core.AccountLink>;
  };
};

export function stripeLivemodeFromSecretKey(secretKey: string | undefined) {
  const value = secretKey?.trim() ?? "";
  if (/^(?:sk|rk)_live_/.test(value)) return true;
  if (/^(?:sk|rk)_test_/.test(value)) return false;
  throw new Error("STRIPE_SECRET_KEY must identify Stripe test or live mode");
}

export function connectOnboardingUrls(rawOrigin: string | undefined): {
  refreshUrl: string;
  returnUrl: string;
} {
  if (
    rawOrigin === undefined ||
    rawOrigin.trim() === "" ||
    rawOrigin.length > 2_048
  ) {
    throw new Error("APP_ORIGIN is not configured");
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute HTTPS URL");
  }
  if (origin.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTPS");
  }
  return {
    refreshUrl: `${origin.origin}/app/earnings?onboarding=refresh`,
    returnUrl: `${origin.origin}/app/earnings?onboarding=return`,
  };
}

function connectOperationIdempotencyKey(
  kind: "account" | "link",
  operationId: string,
): string {
  if (!CONNECT_OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Invalid Connect operation identity");
  }
  return `zevium-connect-${kind}:${operationId}`;
}

function normalizedPublisherCountry(country: string | null): string {
  if (country === null || !/^[A-Z]{2}$/.test(country)) {
    throw new Error("Publisher country must be a two-letter ISO country code");
  }
  if (country === "ZZ") {
    throw new Error("Country ZZ not supported for Connect recipients");
  }
  return country;
}

function boundedContactEmail(contactEmail: string | null): string {
  if (
    contactEmail === null ||
    contactEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/.test(contactEmail)
  ) {
    throw new Error("Signed-in user email is required for Stripe onboarding");
  }
  return contactEmail;
}

function boundedDisplayName(displayName: string): string {
  const value = displayName.trim();
  if (value === "") return "Zevium publisher";
  return [...value].slice(0, 100).join("");
}

function assertHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS`);
  }
  return url;
}

function accountMatchesOperationMetadata(
  account: Stripe.V2.Core.Account,
  expected: ConnectedAccountExpectation & { operationId: string },
): boolean {
  return (
    account.metadata?.zevium_connect_operation_id === expected.operationId &&
    account.metadata.zevium_clerk_org_id === expected.clerkOrgId &&
    account.metadata.zevium_organization_id === expected.organizationId
  );
}

export function assertConnectedAccountIdentity(
  account: Stripe.V2.Core.Account,
  expected: ConnectedAccountExpectation,
): void {
  if (
    account.object !== "v2.core.account" ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(account.id) ||
    (expected.accountId !== undefined && account.id !== expected.accountId)
  ) {
    throw new Error("Stripe returned an unexpected connected account");
  }
  if (account.livemode !== expected.expectedLivemode) {
    throw new Error(
      "Stripe connected account mode does not match configuration",
    );
  }
  if (
    account.closed === true ||
    !account.applied_configurations.includes("recipient") ||
    account.dashboard !== "express" ||
    account.defaults?.responsibilities.fees_collector !== "application" ||
    account.defaults.responsibilities.losses_collector !== "application"
  ) {
    throw new Error(
      "Stripe connected account recipient configuration is invalid",
    );
  }
  const metadataClerkOrgId =
    account.metadata?.zevium_clerk_org_id ?? account.metadata?.clerkOrgId;
  if (metadataClerkOrgId !== expected.clerkOrgId) {
    throw new Error("Stripe connected account organization does not match");
  }
  const metadataOrganizationId = account.metadata?.zevium_organization_id;
  if (
    metadataOrganizationId !== undefined &&
    metadataOrganizationId !== expected.organizationId
  ) {
    throw new Error("Stripe connected account identity does not match");
  }
  if (
    expected.operationId !== undefined &&
    account.metadata?.zevium_connect_operation_id !== expected.operationId
  ) {
    throw new Error("Stripe connected account operation does not match");
  }
  if (
    expected.country !== undefined &&
    account.identity?.country?.toUpperCase() !== expected.country
  ) {
    throw new Error("Stripe connected account country does not match");
  }
}

export async function createConnectedAccountForOperation(
  stripe: ConnectOnboardingClient,
  args: {
    operationId: string;
    clerkOrgId: string;
    organizationId: string;
    organizationName: string;
    country: string;
    contactEmail: string;
    expectedLivemode: boolean;
  },
): Promise<Stripe.V2.Core.Account> {
  const country = normalizedPublisherCountry(args.country);
  const contactEmail = boundedContactEmail(args.contactEmail);
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
      contact_email: contactEmail,
      display_name: boundedDisplayName(args.organizationName),
      identity: { country: country.toLowerCase() },
      include: [
        "configuration.recipient",
        "defaults",
        "identity",
        "requirements",
      ],
      metadata: {
        zevium_clerk_org_id: args.clerkOrgId,
        zevium_connect_operation_id: args.operationId,
        zevium_organization_id: args.organizationId,
      },
    },
    {
      idempotencyKey: connectOperationIdempotencyKey(
        "account",
        args.operationId,
      ),
    },
  );
  assertConnectedAccountIdentity(account, {
    clerkOrgId: args.clerkOrgId,
    organizationId: args.organizationId,
    expectedLivemode: args.expectedLivemode,
    operationId: args.operationId,
    country,
  });
  return account;
}

export async function resolveConnectedAccountForOperation(
  stripe: ConnectOnboardingClient,
  args: Parameters<typeof createConnectedAccountForOperation>[1] & {
    reconcileFirst: boolean;
    operationStartedAt: number;
    now: number;
  },
): Promise<Stripe.V2.Core.Account> {
  if (args.reconcileFirst) {
    const listed = await stripe.accountsV2.listRecipientAccounts(
      CONNECT_ACCOUNT_RECONCILIATION_LIMIT,
    );
    const expected = {
      clerkOrgId: args.clerkOrgId,
      organizationId: args.organizationId,
      expectedLivemode: args.expectedLivemode,
      operationId: args.operationId,
    };
    const matching = listed.filter(
      (account) =>
        accountMatchesOperationMetadata(account, expected) ||
        (account.metadata?.clerkOrgId === args.clerkOrgId &&
          account.metadata.zevium_clerk_org_id === undefined &&
          account.metadata.zevium_connect_operation_id === undefined &&
          account.metadata.zevium_organization_id === undefined),
    );
    if (matching.length > 1) {
      throw new Error("Stripe connected account reconciliation is ambiguous");
    }
    if (listed.length >= CONNECT_ACCOUNT_RECONCILIATION_LIMIT) {
      throw new Error("Stripe connected account reconciliation scan is full");
    }
    if (matching.length === 1) {
      const matchesCurrentOperation = accountMatchesOperationMetadata(
        matching[0],
        expected,
      );
      const account = await stripe.accountsV2.retrieve(matching[0].id, {
        include: ["configuration.recipient", "defaults", "identity"],
      });
      assertConnectedAccountIdentity(account, {
        accountId: matching[0].id,
        clerkOrgId: args.clerkOrgId,
        organizationId: args.organizationId,
        expectedLivemode: args.expectedLivemode,
        ...(matchesCurrentOperation ? { operationId: args.operationId } : {}),
        country: args.country,
      });
      return account;
    }
  }
  if (
    args.reconcileFirst &&
    args.now - args.operationStartedAt >= STRIPE_V2_IDEMPOTENCY_WINDOW_MS
  ) {
    throw new Error("Stripe connected account reconciliation is required");
  }
  return await createConnectedAccountForOperation(stripe, args);
}

export async function retrieveConnectedAccount(
  stripe: ConnectOnboardingClient,
  expected: ConnectedAccountExpectation & { accountId: string },
): Promise<Stripe.V2.Core.Account> {
  const account = await stripe.accountsV2.retrieve(expected.accountId, {
    include: ["configuration.recipient", "defaults", "identity"],
  });
  assertConnectedAccountIdentity(account, expected);
  return account;
}

export async function createAccountLinkForOperation(
  stripe: ConnectOnboardingClient,
  args: {
    operationId: string;
    connectedAccountId: string;
    expectedLivemode: boolean;
    refreshUrl: string;
    returnUrl: string;
  },
): Promise<{ url: string; expiresAt: number }> {
  assertHttpsUrl(args.refreshUrl, "Stripe refresh URL");
  assertHttpsUrl(args.returnUrl, "Stripe return URL");
  const link = await stripe.accountLinksV2.create(
    {
      account: args.connectedAccountId,
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
    },
    {
      idempotencyKey: connectOperationIdempotencyKey("link", args.operationId),
    },
  );
  if (
    link.object !== "v2.core.account_link" ||
    link.account !== args.connectedAccountId
  ) {
    throw new Error("Stripe returned an onboarding link for another account");
  }
  if (link.livemode !== args.expectedLivemode) {
    throw new Error("Stripe onboarding link mode does not match configuration");
  }
  if (
    link.use_case.type !== "account_onboarding" ||
    link.use_case.account_onboarding?.configurations.length !== 1 ||
    link.use_case.account_onboarding.configurations[0] !== "recipient"
  ) {
    throw new Error("Stripe returned an unexpected onboarding link use case");
  }
  assertHttpsUrl(link.url, "Stripe onboarding URL");
  const expiresAt = Date.parse(link.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Stripe returned an invalid onboarding link expiry");
  }
  return { url: link.url, expiresAt };
}

function connectOnboardingClient(stripe: Stripe): ConnectOnboardingClient {
  return {
    accountsV2: {
      create: async (params, options) =>
        await stripe.v2.core.accounts.create(params, options),
      retrieve: async (id, params, options) =>
        await stripe.v2.core.accounts.retrieve(id, params, options),
      listRecipientAccounts: async (limit) =>
        await stripe.v2.core.accounts
          .list({ applied_configurations: ["recipient"], limit: 100 })
          .autoPagingToArray({ limit }),
    },
    accountLinksV2: {
      create: async (params, options) =>
        await stripe.v2.core.accountLinks.create(params, options),
    },
  };
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

export type PreparedConnectAccount = {
  organizationId: Id<"organizations">;
  organizationName: string;
  connectedAccountId: string | null;
  connectedAccountLivemode: boolean | null;
  operation: {
    operationId: string;
    country: string;
    contactEmail: string;
    startedAt: number;
    isRetry: boolean;
  } | null;
};

export const prepareConnectAccountOperation = internalMutation({
  args: {
    clerkOrgId: v.string(),
    candidateOperationId: v.string(),
    expectedLivemode: v.boolean(),
    country: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    requireExistingAccount: v.boolean(),
  },
  handler: async (ctx, args): Promise<PreparedConnectAccount> => {
    if (
      args.clerkOrgId.length > 128 ||
      !/^org_[A-Za-z0-9_-]+$/.test(args.clerkOrgId)
    ) {
      throw new Error("Active organization is invalid");
    }
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .unique();
    if (organization === null) {
      throw new Error("Active organization is not provisioned");
    }
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
    if (profile.stripeConnectedAccountId !== undefined) {
      if (
        profile.stripeConnectedAccountLivemode !== undefined &&
        profile.stripeConnectedAccountLivemode !== args.expectedLivemode
      ) {
        throw new Error(
          "Stored Stripe connected account mode does not match configuration",
        );
      }
      return {
        organizationId: organization._id,
        organizationName: organization.name,
        connectedAccountId: profile.stripeConnectedAccountId,
        connectedAccountLivemode:
          profile.stripeConnectedAccountLivemode ?? null,
        operation: null,
      };
    }
    if (args.requireExistingAccount) {
      throw new Error(
        "Stripe onboarding must be started before it can refresh",
      );
    }
    const pending = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_organization_kind_status", (q) =>
        q
          .eq("organizationId", organization._id)
          .eq("kind", "account_create")
          .eq("status", "prepared"),
      )
      .order("desc")
      .first();
    if (pending !== null) {
      if (
        pending.expectedLivemode !== args.expectedLivemode ||
        pending.country === undefined ||
        pending.contactEmail === undefined
      ) {
        throw new Error("Stripe account creation requires reconciliation");
      }
      return {
        organizationId: organization._id,
        organizationName: organization.name,
        connectedAccountId: null,
        connectedAccountLivemode: null,
        operation: {
          operationId: pending.operationId,
          country: pending.country,
          contactEmail: pending.contactEmail,
          startedAt: pending.createdAt,
          isRetry: true,
        },
      };
    }
    if (!CONNECT_OPERATION_ID_PATTERN.test(args.candidateOperationId)) {
      throw new Error("Invalid Connect operation identity");
    }
    const operationCollision = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) =>
        q.eq("operationId", args.candidateOperationId),
      )
      .unique();
    if (operationCollision !== null) {
      throw new Error("Connect operation identity collision");
    }
    const country = normalizedPublisherCountry(args.country ?? null);
    const contactEmail = boundedContactEmail(args.contactEmail ?? null);
    const now = Date.now();
    await ctx.db.insert("stripeConnectOnboardingOperations", {
      organizationId: organization._id,
      operationId: args.candidateOperationId,
      kind: "account_create",
      status: "prepared",
      expectedLivemode: args.expectedLivemode,
      country,
      contactEmail,
      createdAt: now,
      updatedAt: now,
    });
    return {
      organizationId: organization._id,
      organizationName: organization.name,
      connectedAccountId: null,
      connectedAccountLivemode: null,
      operation: {
        operationId: args.candidateOperationId,
        country,
        contactEmail,
        startedAt: now,
        isRetry: false,
      },
    };
  },
});

export const commitConnectAccountOperation = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    operationId: v.string(),
    stripeConnectedAccountId: v.string(),
    expectedLivemode: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ accepted: boolean; connectedAccountId: string }> => {
    if (!STRIPE_ACCOUNT_ID_PATTERN.test(args.stripeConnectedAccountId)) {
      throw new Error("Stripe returned an invalid connected account ID");
    }
    const operation = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (
      operation === null ||
      operation.organizationId !== args.organizationId ||
      operation.kind !== "account_create" ||
      operation.expectedLivemode !== args.expectedLivemode ||
      (operation.status !== "prepared" &&
        operation.status !== "account_persisted")
    ) {
      throw new Error("Stripe account creation operation is invalid");
    }
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .unique();
    if (profile === null) throw new Error("Payment profile not found");
    if (
      profile.stripeConnectedAccountId !== undefined &&
      (profile.stripeConnectedAccountId !== args.stripeConnectedAccountId ||
        (profile.stripeConnectedAccountLivemode !== undefined &&
          profile.stripeConnectedAccountLivemode !== args.expectedLivemode))
    ) {
      await ctx.db.patch(operation._id, {
        status: "requires_reconciliation",
        stripeConnectedAccountId: args.stripeConnectedAccountId,
        updatedAt: Date.now(),
      });
      return {
        accepted: false,
        connectedAccountId: profile.stripeConnectedAccountId,
      };
    }
    const now = Date.now();
    await ctx.db.patch(profile._id, {
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      stripeConnectedAccountLivemode: args.expectedLivemode,
      updatedAt: now,
    });
    await ctx.db.patch(operation._id, {
      status: "account_persisted",
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      updatedAt: now,
    });
    return {
      accepted: true,
      connectedAccountId: args.stripeConnectedAccountId,
    };
  },
});

export const confirmConnectAccountIdentity = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    stripeConnectedAccountId: v.string(),
    expectedLivemode: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .unique();
    if (
      profile === null ||
      profile.stripeConnectedAccountId !== args.stripeConnectedAccountId
    ) {
      throw new Error("Stored Stripe connected account does not match");
    }
    if (
      profile.stripeConnectedAccountLivemode !== undefined &&
      profile.stripeConnectedAccountLivemode !== args.expectedLivemode
    ) {
      throw new Error(
        "Stored Stripe connected account mode does not match configuration",
      );
    }
    if (profile.stripeConnectedAccountLivemode === undefined) {
      await ctx.db.patch(profile._id, {
        stripeConnectedAccountLivemode: args.expectedLivemode,
        updatedAt: Date.now(),
      });
    }
  },
});

export type PreparedConnectLink = {
  operationId: string;
  connectedAccountId: string;
  expectedLivemode: boolean;
  isRetry: boolean;
};

export const prepareConnectLinkOperation = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    candidateOperationId: v.string(),
    expectedLivemode: v.boolean(),
    forceFresh: v.boolean(),
  },
  handler: async (ctx, args): Promise<PreparedConnectLink> => {
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .unique();
    if (
      profile === null ||
      profile.stripeConnectedAccountId === undefined ||
      profile.stripeConnectedAccountLivemode !== args.expectedLivemode
    ) {
      throw new Error("Connected account must be persisted before onboarding");
    }
    const now = Date.now();
    const pending = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_organization_kind_status", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("kind", "account_link")
          .eq("status", "prepared"),
      )
      .order("desc")
      .first();
    if (pending !== null) {
      const canRetry =
        !args.forceFresh &&
        pending.expectedLivemode === args.expectedLivemode &&
        pending.stripeConnectedAccountId === profile.stripeConnectedAccountId &&
        now - pending.createdAt < CONNECT_LINK_RETRY_WINDOW_MS;
      if (canRetry) {
        return {
          operationId: pending.operationId,
          connectedAccountId: profile.stripeConnectedAccountId,
          expectedLivemode: args.expectedLivemode,
          isRetry: true,
        };
      }
      await ctx.db.patch(pending._id, {
        status: "expired",
        contactEmail: null,
        updatedAt: now,
      });
    }
    if (!CONNECT_OPERATION_ID_PATTERN.test(args.candidateOperationId)) {
      throw new Error("Invalid Connect operation identity");
    }
    const operationCollision = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) =>
        q.eq("operationId", args.candidateOperationId),
      )
      .unique();
    if (operationCollision !== null) {
      throw new Error("Connect operation identity collision");
    }
    await ctx.db.insert("stripeConnectOnboardingOperations", {
      organizationId: args.organizationId,
      operationId: args.candidateOperationId,
      kind: "account_link",
      status: "prepared",
      expectedLivemode: args.expectedLivemode,
      stripeConnectedAccountId: profile.stripeConnectedAccountId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      operationId: args.candidateOperationId,
      connectedAccountId: profile.stripeConnectedAccountId,
      expectedLivemode: args.expectedLivemode,
      isRetry: false,
    };
  },
});

export const expireConnectLinkOperation = internalMutation({
  args: { operationId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const operation = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (
      operation !== null &&
      operation.kind === "account_link" &&
      operation.status === "prepared"
    ) {
      await ctx.db.patch(operation._id, {
        status: "expired",
        contactEmail: null,
        updatedAt: Date.now(),
      });
    }
  },
});

export const completeConnectLinkOperation = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    operationId: v.string(),
    stripeConnectedAccountId: v.string(),
    expectedLivemode: v.boolean(),
    providerExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const operation = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (operation?.status === "link_created") {
      return (
        operation.organizationId === args.organizationId &&
        operation.stripeConnectedAccountId === args.stripeConnectedAccountId &&
        operation.expectedLivemode === args.expectedLivemode
      );
    }
    if (
      operation === null ||
      operation.kind !== "account_link" ||
      operation.status !== "prepared" ||
      operation.organizationId !== args.organizationId ||
      operation.stripeConnectedAccountId !== args.stripeConnectedAccountId ||
      operation.expectedLivemode !== args.expectedLivemode ||
      !Number.isSafeInteger(args.providerExpiresAt)
    ) {
      return false;
    }
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .unique();
    if (
      profile === null ||
      profile.stripeConnectedAccountId !== args.stripeConnectedAccountId ||
      profile.stripeConnectedAccountLivemode !== args.expectedLivemode
    ) {
      return false;
    }
    await ctx.db.patch(operation._id, {
      status: "link_created",
      providerExpiresAt: args.providerExpiresAt,
      updatedAt: Date.now(),
    });
    return true;
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
  if (account.closed === true) {
    return {
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      disabledReason: "account_closed",
      requirements: [],
    };
  }
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
    await ctx.runMutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: account.id,
      ...connectAccountProjection(account),
    });
  },
});

export type ConnectOnboardingStore = {
  prepareAccount: (args: {
    clerkOrgId: string;
    candidateOperationId: string;
    expectedLivemode: boolean;
    country?: string;
    contactEmail?: string;
    requireExistingAccount: boolean;
  }) => Promise<PreparedConnectAccount>;
  commitAccount: (args: {
    organizationId: Id<"organizations">;
    operationId: string;
    stripeConnectedAccountId: string;
    expectedLivemode: boolean;
  }) => Promise<{ accepted: boolean; connectedAccountId: string }>;
  confirmAccount: (args: {
    organizationId: Id<"organizations">;
    stripeConnectedAccountId: string;
    expectedLivemode: boolean;
  }) => Promise<void>;
  prepareLink: (args: {
    organizationId: Id<"organizations">;
    candidateOperationId: string;
    expectedLivemode: boolean;
    forceFresh: boolean;
  }) => Promise<PreparedConnectLink>;
  expireLink: (args: { operationId: string }) => Promise<void>;
  completeLink: (args: {
    organizationId: Id<"organizations">;
    operationId: string;
    stripeConnectedAccountId: string;
    expectedLivemode: boolean;
    providerExpiresAt: number;
  }) => Promise<boolean>;
};

export type ConnectOnboardingWorkflowDependencies = {
  stripe: ConnectOnboardingClient;
  store: ConnectOnboardingStore;
  expectedLivemode: boolean;
  refreshUrl: string;
  returnUrl: string;
  newOperationId: () => string;
  now: () => number;
};

export async function runConnectOnboardingWorkflow(
  actor: {
    clerkOrgId: string;
    contactEmail: string | null;
  },
  input: {
    country: string | null;
    forceFreshLink: boolean;
    requireExistingAccount: boolean;
  },
  dependencies: ConnectOnboardingWorkflowDependencies,
): Promise<{ url: string }> {
  const prepared = await dependencies.store.prepareAccount({
    clerkOrgId: actor.clerkOrgId,
    candidateOperationId: dependencies.newOperationId(),
    expectedLivemode: dependencies.expectedLivemode,
    ...(input.country === null ? {} : { country: input.country }),
    ...(actor.contactEmail === null
      ? {}
      : { contactEmail: actor.contactEmail }),
    requireExistingAccount: input.requireExistingAccount,
  });

  let connectedAccountId = prepared.connectedAccountId;
  if (connectedAccountId === null) {
    if (prepared.operation === null) {
      throw new Error("Stripe account creation operation is missing");
    }
    const account = await resolveConnectedAccountForOperation(
      dependencies.stripe,
      {
        operationId: prepared.operation.operationId,
        clerkOrgId: actor.clerkOrgId,
        organizationId: prepared.organizationId,
        organizationName: prepared.organizationName,
        country: prepared.operation.country,
        contactEmail: prepared.operation.contactEmail,
        expectedLivemode: dependencies.expectedLivemode,
        // First run also scans for a 5f8-era account created before the old
        // v1 Account Link failure prevented its local persistence.
        reconcileFirst: true,
        operationStartedAt: prepared.operation.startedAt,
        now: dependencies.now(),
      },
    );
    const committed = await dependencies.store.commitAccount({
      organizationId: prepared.organizationId,
      operationId: prepared.operation.operationId,
      stripeConnectedAccountId: account.id,
      expectedLivemode: dependencies.expectedLivemode,
    });
    if (!committed.accepted || committed.connectedAccountId !== account.id) {
      throw new Error("Stripe connected account reconciliation is required");
    }
    connectedAccountId = account.id;
  } else {
    await retrieveConnectedAccount(dependencies.stripe, {
      accountId: connectedAccountId,
      clerkOrgId: actor.clerkOrgId,
      organizationId: prepared.organizationId,
      expectedLivemode: dependencies.expectedLivemode,
    });
    await dependencies.store.confirmAccount({
      organizationId: prepared.organizationId,
      stripeConnectedAccountId: connectedAccountId,
      expectedLivemode: dependencies.expectedLivemode,
    });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const linkOperation = await dependencies.store.prepareLink({
      organizationId: prepared.organizationId,
      candidateOperationId: dependencies.newOperationId(),
      expectedLivemode: dependencies.expectedLivemode,
      forceFresh: input.forceFreshLink || attempt > 0,
    });
    const link = await createAccountLinkForOperation(dependencies.stripe, {
      operationId: linkOperation.operationId,
      connectedAccountId,
      expectedLivemode: dependencies.expectedLivemode,
      refreshUrl: dependencies.refreshUrl,
      returnUrl: dependencies.returnUrl,
    });
    if (link.expiresAt <= dependencies.now() + CONNECT_LINK_MIN_VALIDITY_MS) {
      await dependencies.store.expireLink({
        operationId: linkOperation.operationId,
      });
      continue;
    }
    const completed = await dependencies.store.completeLink({
      organizationId: prepared.organizationId,
      operationId: linkOperation.operationId,
      stripeConnectedAccountId: connectedAccountId,
      expectedLivemode: dependencies.expectedLivemode,
      providerExpiresAt: link.expiresAt,
    });
    if (completed) return { url: link.url };
  }
  throw new Error("Could not create a fresh Stripe onboarding link");
}

function connectOnboardingStore(ctx: ActionCtx): ConnectOnboardingStore {
  return {
    prepareAccount: async (args) =>
      await ctx.runMutation(
        internal.payouts.prepareConnectAccountOperation,
        args,
      ),
    commitAccount: async (args) =>
      await ctx.runMutation(
        internal.payouts.commitConnectAccountOperation,
        args,
      ),
    confirmAccount: async (args) => {
      await ctx.runMutation(
        internal.payouts.confirmConnectAccountIdentity,
        args,
      );
    },
    prepareLink: async (args) =>
      await ctx.runMutation(internal.payouts.prepareConnectLinkOperation, args),
    expireLink: async (args) => {
      await ctx.runMutation(internal.payouts.expireConnectLinkOperation, args);
    },
    completeLink: async (args) =>
      await ctx.runMutation(
        internal.payouts.completeConnectLinkOperation,
        args,
      ),
  };
}

async function runConnectOnboardingAction(
  ctx: ActionCtx,
  args: {
    country: string | null;
    forceFreshLink: boolean;
    requireExistingAccount: boolean;
  },
): Promise<{ url: string }> {
  const { clerkOrgId, identity } =
    await requireActiveClerkOrgAdminInAction(ctx);
  if (args.country !== null && args.country.length > 8) {
    throw new Error("Publisher country must be a two-letter ISO country code");
  }
  const input = {
    ...args,
    country: args.country?.trim().toUpperCase() ?? null,
  };
  const rawEmail = typeof identity.email === "string" ? identity.email : "";
  const contactEmail = rawEmail.trim() === "" ? null : rawEmail.trim();
  const expectedLivemode = stripeLivemodeFromSecretKey(
    process.env.STRIPE_SECRET_KEY,
  );
  const urls = connectOnboardingUrls(process.env.APP_ORIGIN);
  const stripe = stripeClient();
  return await runConnectOnboardingWorkflow(
    { clerkOrgId, contactEmail },
    input,
    {
      stripe: connectOnboardingClient(stripe),
      store: connectOnboardingStore(ctx),
      expectedLivemode,
      ...urls,
      newOperationId: () => crypto.randomUUID(),
      now: () => Date.now(),
    },
  );
}

export const startOnboarding = action({
  args: { country: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> =>
    await runConnectOnboardingAction(ctx, {
      country: args.country ?? null,
      forceFreshLink: false,
      requireExistingAccount: false,
    }),
});

export const refreshOnboarding = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> =>
    await runConnectOnboardingAction(ctx, {
      country: null,
      forceFreshLink: true,
      requireExistingAccount: true,
    }),
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
        retry.metadataRepairVersion !== 1 ||
        retry.providerCreateMetadataShape !== "correlated_v1" ||
        retry.correlationNonce === undefined ||
        retry.correlationHmac === undefined ||
        retry.platformAccountId === undefined
      ) {
        throw new Error("Legacy transfer provider metadata repair is required");
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
        existing.metadataRepairVersion !== 1 ||
        existing.providerCreateMetadataShape !== "correlated_v1" ||
        existing.correlationNonce === undefined ||
        existing.correlationHmac === undefined ||
        existing.platformAccountId === undefined
      ) {
        throw new Error("Legacy transfer provider metadata repair is required");
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
      metadataRepairVersion: 1,
      providerCreateMetadataShape: "correlated_v1",
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
      correlationState: "local_prepared" as const,
      metadataRepairVersion: 1,
      providerCreateMetadataShape: "correlated_v1" as const,
      stripeTransferId: undefined,
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
    failed: boolean;
    failureReason?: string;
  },
): Promise<void> {
  if (
    transfer.correlationState === undefined ||
    transfer.correlationState === "provider_repair_required" ||
    transfer.metadataRepairVersion !== 1 ||
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
  },
): Promise<void> {
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
    transfer.metadataRepairVersion !== 1 ||
    args.metadataRepairVersion !== 1 ||
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
          candidate.metadataRepairVersion === 1 &&
          candidate.correlationNonce !== undefined &&
          candidate.correlationHmac !== undefined &&
          candidate.platformAccountId !== undefined &&
          args.correlationNonce === candidate.correlationNonce &&
          args.correlationHmac === candidate.correlationHmac &&
          args.metadataRepairVersion === candidate.metadataRepairVersion &&
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
      metadataRepairVersion: args.metadataRepairVersion,
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
    await assertStripeTransferSnapshotMatches(transfer, args);
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
      metadataRepairVersion: 1,
      updatedAt: Date.now(),
    });
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

export type StripeTransferRepairClient = StripeTransferClient & {
  update: Stripe["transfers"]["update"];
};

function transferDestination(transfer: Stripe.Transfer): string {
  return typeof transfer.destination === "string"
    ? transfer.destination
    : (transfer.destination?.id ?? "");
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
 * Provider repair uses original legacy create parameters on idempotent replay,
 * then a distinct metadata-update request. Local HMAC is never called proof
 * until the final provider retrieval returns every expected metadata field.
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
    let metadata: Stripe.MetadataParam;
    if (transfer.providerCreateMetadataShape === "publisher_only") {
      metadata = { publisherTransferId: String(transfer._id) };
    } else {
      metadata = {
        publisherTransferId: String(transfer._id),
        correlationNonce: transfer.correlationNonce,
        correlationHmac: transfer.correlationHmac,
        platformAccountId: transfer.platformAccountId,
      };
      if (transfer.providerCreateMetadataShape === "correlated_v1") {
        metadata.metadataRepairVersion = "1";
      }
    }
    const replay = await stripe.create(
      {
        amount: transfer.amount,
        currency: transfer.currency,
        destination: transfer.stripeConnectedAccountId,
        // Exact original request shape. Adding or dropping correlation here
        // violates Stripe idempotency parameter matching after response loss.
        metadata,
      },
      { idempotencyKey: transfer.idempotencyKey },
    );
    snapshot = await stripe.retrieve(replay.id);
  } else {
    snapshot = await stripe.retrieve(transfer.stripeTransferId);
  }
  assertLegacyTransferSnapshot(transfer, snapshot);

  const expected = {
    publisherTransferId: String(transfer._id),
    correlationNonce: transfer.correlationNonce,
    correlationHmac: transfer.correlationHmac,
    platformAccountId: transfer.platformAccountId,
    metadataRepairVersion: "1",
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
        idempotencyKey: `publisher-transfer-metadata-repair:v1:${snapshot.id}`,
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
    correlationState?: Doc<"publisherTransfers">["correlationState"];
    metadataRepairVersion?: number;
    providerCreateMetadataShape?: Doc<"publisherTransfers">["providerCreateMetadataShape"];
    stripeTransferId?: string;
  },
): Promise<Stripe.Transfer> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined ||
    (transfer.correlationState !== "local_prepared" &&
      transfer.correlationState !== "provider_verified") ||
    transfer.metadataRepairVersion !== 1 ||
    transfer.providerCreateMetadataShape !== "correlated_v1"
  ) {
    throw new Error("Transfer correlation migration is incomplete");
  }
  if (transfer.stripeTransferId !== undefined) {
    return await stripe.retrieve(transfer.stripeTransferId);
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
        metadataRepairVersion: "1",
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
    correlationState?: Doc<"publisherTransfers">["correlationState"];
    metadataRepairVersion?: number;
    providerCreateMetadataShape?: Doc<"publisherTransfers">["providerCreateMetadataShape"];
    stripeTransferId?: string;
  },
): Promise<void> {
  if (
    transfer.correlationNonce === undefined ||
    transfer.correlationHmac === undefined ||
    transfer.platformAccountId === undefined ||
    (transfer.correlationState !== "local_prepared" &&
      transfer.correlationState !== "provider_verified") ||
    transfer.metadataRepairVersion !== 1 ||
    transfer.providerCreateMetadataShape !== "correlated_v1"
  ) {
    throw new Error("Transfer correlation migration is incomplete");
  }
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
      metadataRepairVersion:
        stripeTransfer.metadata.metadataRepairVersion === undefined
          ? undefined
          : Number(stripeTransfer.metadata.metadataRepairVersion),
      failed: false,
      failureReason: undefined,
    });
  } catch (error) {
    // Network/client failure is ambiguous. Only a verified provider snapshot
    // or transfer.failed webhook may classify external money as failed.
    throw new Error("Provider transfer failed. Try again or contact support.");
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
      correlationState: prepared.correlationState,
      metadataRepairVersion: prepared.metadataRepairVersion,
      providerCreateMetadataShape: prepared.providerCreateMetadataShape,
      stripeTransferId: prepared.stripeTransferId,
    });
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
      if (
        transfer.reversedAmount === undefined ||
        transfer.correlationNonce === undefined ||
        transfer.correlationHmac === undefined ||
        transfer.platformAccountId === undefined ||
        transfer.correlationState === undefined ||
        transfer.correlationState === "provider_repair_required" ||
        transfer.metadataRepairVersion !== 1 ||
        transfer.providerCreateMetadataShape === undefined ||
        (transfer.correlationState === "provider_verified" &&
          transfer.providerMetadataVerifiedAt === undefined)
      ) {
        throw new Error("Transfer correlation migration is incomplete");
      }
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
