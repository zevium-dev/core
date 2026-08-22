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
  internalQuery,
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
  assertPublisherEarningReady,
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

/** Legacy v1 provider metadata fingerprint (metadataRepairVersion "1"). */
function legacyProviderRequestFingerprint(args: {
  amount: number;
  currency: string;
  destination: string;
  publisherTransferId: string;
  correlationNonce: string;
  correlationHmac: string;
  platformAccountId: string;
}): string {
  return JSON.stringify({
    amount: args.amount,
    currency: args.currency.toLowerCase(),
    destination: args.destination,
    metadata: {
      correlationHmac: args.correlationHmac,
      correlationNonce: args.correlationNonce,
      metadataRepairVersion: "1",
      platformAccountId: args.platformAccountId,
      publisherTransferId: args.publisherTransferId,
    },
  });
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

const STRIPE_V2_IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const CONNECT_LINK_RETRY_WINDOW_MS = 4 * 60 * 1_000;
const CONNECT_LINK_MIN_VALIDITY_MS = 30 * 1_000;
const CONNECT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const CONNECT_ONBOARDING_HOSTS = new Set([
  "connect.stripe.com",
  "connect.stripe.test",
  "connect.stripe.sandbox",
]);
const SUPPORTED_CONNECT_COUNTRIES = new Set([
  "AE",
  "AT",
  "AU",
  "BE",
  "BG",
  "BR",
  "CA",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HK",
  "HR",
  "HU",
  "ID",
  "IE",
  "IN",
  "IT",
  "JP",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "MX",
  "MY",
  "NL",
  "NO",
  "NZ",
  "PH",
  "PL",
  "PT",
  "RO",
  "SE",
  "SG",
  "SI",
  "SK",
  "TH",
  "US",
]);

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

function connectProviderErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    if (typeof raw.code === "string" && /^[a-z0-9_]{1,80}$/.test(raw.code)) {
      return raw.code;
    }
    if (typeof raw.type === "string" && /^[a-z0-9_]{1,80}$/.test(raw.type)) {
      return raw.type;
    }
  }
  return "provider_create_failed";
}

function isDefinitiveConnectCreateFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const status = (error as Record<string, unknown>).status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 409
  );
}

export async function verifyStripePlatformIdentity(
  stripe: Stripe,
  expectedLivemode: boolean,
): Promise<void> {
  const configured = stripePlatformAccountId();
  const sandbox = process.env.STRIPE_SANDBOX;
  if (sandbox !== undefined && sandbox !== String(!expectedLivemode)) {
    throw new Error("Stripe sandbox configuration does not match secret key");
  }
  const account = await stripe.accounts.retrieve(configured);
  const providerLivemode = (account as unknown as { livemode?: unknown })
    .livemode;
  if (
    account.id !== configured ||
    providerLivemode !== expectedLivemode ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(account.id)
  ) {
    throw new Error("Stripe platform identity does not match configuration");
  }
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
  if (
    country === null ||
    !/^[A-Z]{2}$/.test(country) ||
    !SUPPORTED_CONNECT_COUNTRIES.has(country)
  ) {
    throw new Error(
      "Publisher country is not supported for Connect recipients",
    );
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

export function connectAccountRequestFingerprint(args: {
  organizationId: string;
  clerkOrgId: string;
  organizationName: string;
  country: string;
  contactEmail: string;
  expectedLivemode: boolean;
}): string {
  return JSON.stringify({
    clerkOrgId: args.clerkOrgId,
    contactEmail: args.contactEmail,
    country: args.country,
    dashboard: "express",
    defaults: {
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application",
        requirements_collector: "stripe",
      },
    },
    displayName: boundedDisplayName(args.organizationName),
    expectedLivemode: args.expectedLivemode,
    identity: { country: args.country.toLowerCase() },
    organizationId: args.organizationId,
  });
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

function assertStripeOnboardingUrl(value: string): URL {
  const url = assertHttpsUrl(value, "Stripe onboarding URL");
  if (!CONNECT_ONBOARDING_HOSTS.has(url.hostname)) {
    throw new Error("Stripe returned an untrusted onboarding host");
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
  const raw = account as unknown as Record<string, unknown>;
  const appliedConfigurations = raw.applied_configurations;
  const defaults = raw.defaults;
  const responsibilities =
    defaults !== null && typeof defaults === "object"
      ? (defaults as Record<string, unknown>).responsibilities
      : undefined;
  const configuration = raw.configuration;
  const recipient =
    configuration !== null && typeof configuration === "object"
      ? (configuration as Record<string, unknown>).recipient
      : undefined;
  const recipientRecord =
    recipient !== null && typeof recipient === "object"
      ? (recipient as Record<string, unknown>)
      : undefined;
  const capabilities = recipientRecord?.capabilities;
  const stripeBalance =
    capabilities !== null && typeof capabilities === "object"
      ? (capabilities as Record<string, unknown>).stripe_balance
      : undefined;
  const stripeBalanceRecord =
    stripeBalance !== null && typeof stripeBalance === "object"
      ? (stripeBalance as Record<string, unknown>)
      : undefined;
  const transfers = stripeBalanceRecord?.stripe_transfers;
  const transferRecord =
    transfers !== null && typeof transfers === "object"
      ? (transfers as Record<string, unknown>)
      : undefined;
  const responsibilityRecord =
    responsibilities !== null && typeof responsibilities === "object"
      ? (responsibilities as Record<string, unknown>)
      : undefined;
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
    !Array.isArray(appliedConfigurations) ||
    appliedConfigurations.length !== 1 ||
    appliedConfigurations[0] !== "recipient" ||
    account.dashboard !== "express" ||
    responsibilityRecord?.fees_collector !== "application" ||
    responsibilityRecord?.losses_collector !== "application" ||
    responsibilityRecord?.requirements_collector !== "stripe" ||
    recipientRecord?.applied !== true ||
    transferRecord === undefined
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
    if (listed.length >= CONNECT_ACCOUNT_RECONCILIATION_LIMIT) {
      throw new Error("Stripe connected account reconciliation scan is full");
    }
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
  assertStripeOnboardingUrl(link.url);
  const onboarding = link.use_case.account_onboarding;
  if (
    onboarding === undefined ||
    onboarding.collection_options?.fields !== "eventually_due" ||
    onboarding.collection_options.future_requirements !== "include" ||
    onboarding.refresh_url !== args.refreshUrl ||
    onboarding.return_url !== args.returnUrl
  ) {
    throw new Error("Stripe returned unexpected onboarding link options");
  }
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
          .autoPagingToArray({ limit: Math.max(limit, 100_000) }),
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
    await assertFinanceMigrationAllowsRuntime(ctx);
    const organization = await getOrgByClerkId(ctx, args.clerkOrgId);

    if (organization === null)
      throw new Error("Active organization is not provisioned");
    if (organization.archivedAt !== undefined) {
      throw new Error("Organization is archived");
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
    allowClosedReplacement: v.optional(v.boolean()),
    requestFingerprint: v.optional(v.string()),
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
    if (organization.archivedAt !== undefined) {
      throw new Error("Organization is archived");
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
        profile.stripeConnectedAccountLivemode === undefined ||
        profile.stripeConnectedAccountLivemode !== args.expectedLivemode
      ) {
        throw new Error(
          "Stored Stripe connected account mode does not match configuration",
        );
      }
      if (
        args.allowClosedReplacement !== true ||
        profile.disabledReason !== "account_closed"
      ) {
        return {
          organizationId: organization._id,
          organizationName: organization.name,
          connectedAccountId: profile.stripeConnectedAccountId,
          connectedAccountLivemode: profile.stripeConnectedAccountLivemode,
          operation: null,
        };
      }
    }
    if (args.requireExistingAccount && args.allowClosedReplacement !== true) {
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
    const requestFingerprint =
      args.requestFingerprint ??
      connectAccountRequestFingerprint({
        organizationId: organization._id,
        clerkOrgId: args.clerkOrgId,
        organizationName: organization.name,
        country,
        contactEmail,
        expectedLivemode: args.expectedLivemode,
      });
    if (requestFingerprint.length > 2_048) {
      throw new Error("Stripe account request fingerprint is invalid");
    }
    const now = Date.now();
    await ctx.db.insert("stripeConnectOnboardingOperations", {
      organizationId: organization._id,
      operationId: args.candidateOperationId,
      kind: "account_create",
      status: "prepared",
      expectedLivemode: args.expectedLivemode,
      country,
      contactEmail,
      providerRequestFingerprint: requestFingerprint,
      piiExpiresAt: now + 24 * 60 * 60 * 1_000,
      ...(profile.disabledReason === "account_closed" &&
      args.allowClosedReplacement === true &&
      profile.stripeConnectedAccountId !== undefined
        ? { replacementOfAccountId: profile.stripeConnectedAccountId }
        : {}),
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
    platformAccountId: v.optional(v.string()),
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
    const isReplacement =
      operation.replacementOfAccountId !== undefined &&
      operation.replacementOfAccountId === profile.stripeConnectedAccountId;
    if (
      profile.stripeConnectedAccountId !== undefined &&
      !isReplacement &&
      (profile.stripeConnectedAccountId !== args.stripeConnectedAccountId ||
        profile.stripeConnectedAccountLivemode !== args.expectedLivemode)
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
    const claim = await ctx.db
      .query("connectedAccountClaims")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", args.stripeConnectedAccountId),
      )
      .unique();
    if (
      claim !== null &&
      (claim.organizationId !== args.organizationId ||
        claim.livemode !== args.expectedLivemode)
    ) {
      throw new Error("Stripe connected account is already claimed");
    }
    if (claim === null) {
      await ctx.db.insert("connectedAccountClaims", {
        stripeConnectedAccountId: args.stripeConnectedAccountId,
        organizationId: args.organizationId,
        livemode: args.expectedLivemode,
        claimedAt: Date.now(),
      });
    }
    const now = Date.now();
    await ctx.db.patch(profile._id, {
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      stripeConnectedAccountLivemode: args.expectedLivemode,
      ...(args.platformAccountId === undefined
        ? {}
        : { stripePlatformAccountId: args.platformAccountId }),
      updatedAt: now,
    });
    await ctx.db.patch(operation._id, {
      status: "account_persisted",
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      country: undefined,
      contactEmail: undefined,
      piiExpiresAt: undefined,
      updatedAt: now,
    });
    return {
      accepted: true,
      connectedAccountId: args.stripeConnectedAccountId,
    };
  },
});

export const markConnectAccountCreateOutcome = internalMutation({
  args: {
    operationId: v.string(),
    code: v.string(),
    definitiveNoSideEffect: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const operation = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (operation === null || operation.kind !== "account_create") return;
    if (operation.status !== "prepared") return;
    const now = Date.now();
    if (args.definitiveNoSideEffect) {
      await ctx.db.patch(operation._id, {
        status: "failed",
        country: undefined,
        contactEmail: undefined,
        piiExpiresAt: undefined,
        providerErrorCode: args.code,
        updatedAt: now,
      });
      return;
    }
    const caseId = await ctx.db.insert("financeReconciliationCases", {
      kind: "account_create",
      status: "open",
      reason: "ambiguous_account_create",
      organizationId: operation.organizationId,
      operationId: operation.operationId,
      candidateIds: [],
      candidateCount: 0,
      providerRequestIds: [],
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operation._id, {
      status: "requires_reconciliation",
      providerErrorCode: args.code,
      reconciliationCaseId: caseId,
      updatedAt: now,
    });
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
      profile.stripeConnectedAccountLivemode === undefined ||
      profile.stripeConnectedAccountLivemode !== args.expectedLivemode
    ) {
      throw new Error(
        "Stored Stripe connected account mode does not match configuration",
      );
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
        contactEmail: undefined,
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
        contactEmail: undefined,
        updatedAt: Date.now(),
      });
    }
  },
});

export const cleanupConnectOperationPii = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ cleared: number }> => {
    const rows = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_pii_expiry", (q) => q.lte("piiExpiresAt", Date.now()))
      .take(100);
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        country: undefined,
        contactEmail: undefined,
        piiExpiresAt: undefined,
      });
    }
    if (rows.length === 100) {
      await ctx.scheduler.runAfter(
        0,
        internal.payouts.cleanupConnectOperationPii,
        {},
      );
    }
    return { cleared: rows.length };
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
    expectedLivemode: v.boolean(),
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
      existing.stripeConnectedAccountLivemode !== undefined &&
      existing.stripeConnectedAccountLivemode !== args.expectedLivemode
    ) {
      throw new Error(
        "Stored Stripe connected account mode does not match configuration",
      );
    }
    if (
      existing.stripeConnectedAccountId !== undefined &&
      existing.stripeConnectedAccountId !== args.stripeConnectedAccountId
    ) {
      return existing.stripeConnectedAccountId;
    }
    const claim = await ctx.db
      .query("connectedAccountClaims")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", args.stripeConnectedAccountId),
      )
      .unique();
    if (
      claim !== null &&
      (claim.organizationId !== args.organizationId ||
        claim.livemode !== args.expectedLivemode)
    ) {
      throw new Error("Stripe connected account is already claimed");
    }
    if (claim === null) {
      await ctx.db.insert("connectedAccountClaims", {
        stripeConnectedAccountId: args.stripeConnectedAccountId,
        organizationId: args.organizationId,
        livemode: args.expectedLivemode,
        claimedAt: Date.now(),
      });
    }
    await ctx.db.patch(existing._id, {
      stripeConnectedAccountId: args.stripeConnectedAccountId,
      stripeConnectedAccountLivemode: args.expectedLivemode,
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
    const expectation = await ctx.runQuery(
      internal.payouts.getConnectedAccountExpectation,
      { stripeConnectedAccountId: args.stripeConnectedAccountId },
    );
    if (expectation === null) return;
    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    const stripe = stripeClient();
    await verifyStripePlatformIdentity(stripe, expectedLivemode);
    const account = await stripe.v2.core.accounts.retrieve(
      args.stripeConnectedAccountId,
      {
        include: [
          "configuration.recipient",
          "defaults",
          "identity",
          "requirements",
        ],
      },
    );
    if (account.closed === true) {
      assertConnectedAccountIdentity(
        { ...account, closed: false },
        {
          accountId: args.stripeConnectedAccountId,
          clerkOrgId: expectation.clerkOrgId,
          organizationId: expectation.organizationId,
          expectedLivemode,
        },
      );
    } else {
      assertConnectedAccountIdentity(account, {
        accountId: args.stripeConnectedAccountId,
        clerkOrgId: expectation.clerkOrgId,
        organizationId: expectation.organizationId,
        expectedLivemode,
      });
    }
    await ctx.runMutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: account.id,
      ...connectAccountProjection(account),
    });
  },
});

export const getConnectedAccountExpectation = internalQuery({
  args: { stripeConnectedAccountId: v.string() },
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("organizationPayments")
      .withIndex("by_connected_account", (q) =>
        q.eq("stripeConnectedAccountId", args.stripeConnectedAccountId),
      )
      .unique();
    if (profile === null) return null;
    const organization = await ctx.db.get(profile.organizationId);
    if (organization === null) return null;
    return {
      organizationId: organization._id,
      clerkOrgId: organization.clerkOrgId,
    };
  },
});

export const getConnectOnboardingOperation = internalQuery({
  args: { operationId: v.string() },
  handler: async (ctx, args) => {
    const operation = await ctx.db
      .query("stripeConnectOnboardingOperations")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    const organization =
      operation === null ? null : await ctx.db.get(operation.organizationId);
    return operation === null
      ? null
      : { ...operation, clerkOrgId: organization?.clerkOrgId ?? "" };
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
    allowClosedReplacement?: boolean;
    requestFingerprint?: string;
  }) => Promise<PreparedConnectAccount>;
  commitAccount: (args: {
    organizationId: Id<"organizations">;
    operationId: string;
    stripeConnectedAccountId: string;
    expectedLivemode: boolean;
    platformAccountId?: string;
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
  platformAccountId: string;
  newOperationId: () => string;
  now: () => number;
  markAccountFailure?: (args: {
    operationId: string;
    code: string;
    definitiveNoSideEffect: boolean;
  }) => Promise<void>;
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
    allowClosedReplacement?: boolean;
  },
  dependencies: ConnectOnboardingWorkflowDependencies,
): Promise<{ url: string }> {
  const candidateOperationId = dependencies.newOperationId();
  const prepared = await dependencies.store.prepareAccount({
    clerkOrgId: actor.clerkOrgId,
    candidateOperationId,
    expectedLivemode: dependencies.expectedLivemode,
    ...(input.country === null ? {} : { country: input.country }),
    ...(actor.contactEmail === null
      ? {}
      : { contactEmail: actor.contactEmail }),
    requireExistingAccount: input.requireExistingAccount,
    ...(input.allowClosedReplacement === undefined
      ? {}
      : { allowClosedReplacement: input.allowClosedReplacement }),
  });

  let connectedAccountId = prepared.connectedAccountId;
  if (connectedAccountId === null) {
    if (prepared.operation === null) {
      throw new Error("Stripe account creation operation is missing");
    }
    let account: Stripe.V2.Core.Account;
    try {
      account = await resolveConnectedAccountForOperation(dependencies.stripe, {
        operationId: prepared.operation.operationId,
        clerkOrgId: actor.clerkOrgId,
        organizationId: prepared.organizationId,
        organizationName: prepared.organizationName,
        country: prepared.operation.country,
        contactEmail: prepared.operation.contactEmail,
        expectedLivemode: dependencies.expectedLivemode,
        reconcileFirst: prepared.operation.isRetry,
        operationStartedAt: prepared.operation.startedAt,
        now: dependencies.now(),
      });
    } catch (error) {
      if (dependencies.markAccountFailure !== undefined) {
        await dependencies.markAccountFailure({
          operationId: prepared.operation.operationId,
          code: connectProviderErrorCode(error),
          definitiveNoSideEffect: isDefinitiveConnectCreateFailure(error),
        });
      }
      throw error;
    }
    const committed = await dependencies.store.commitAccount({
      organizationId: prepared.organizationId,
      operationId: prepared.operation.operationId,
      stripeConnectedAccountId: account.id,
      expectedLivemode: dependencies.expectedLivemode,
      platformAccountId: dependencies.platformAccountId,
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

const CONNECT_ACCOUNT_RECONCILIATION_LIMIT = 100;

async function runConnectOnboardingAction(
  ctx: ActionCtx,
  args: {
    country: string | null;
    forceFreshLink: boolean;
    requireExistingAccount: boolean;
    allowClosedReplacement?: boolean;
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
  await verifyStripePlatformIdentity(stripe, expectedLivemode);
  try {
    return await runConnectOnboardingWorkflow(
      { clerkOrgId, contactEmail },
      input,
      {
        stripe: connectOnboardingClient(stripe),
        store: connectOnboardingStore(ctx),
        expectedLivemode,
        platformAccountId: stripePlatformAccountId(),
        ...urls,
        newOperationId: () => crypto.randomUUID(),
        now: () => Date.now(),
        markAccountFailure: async (failure) => {
          await ctx.runMutation(
            internal.payouts.markConnectAccountCreateOutcome,
            failure,
          );
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Stripe connected account reconciliation is required") {
      throw new Error("CONNECT_ACCOUNT_RECONCILIATION_REQUIRED");
    }
    if (
      message === "TRANSFER_REQUIRES_RECONCILIATION" ||
      message === "TRANSFER_PROVIDER_REJECTED"
    ) {
      throw error;
    }
    if (
      message.includes("Stripe") &&
      !message.includes("country") &&
      !message.includes("HTTPS")
    ) {
      throw new Error("CONNECT_PROVIDER_REJECTED");
    }
    if (/^[a-z0-9_]{3,80}$/.test(message)) {
      throw new Error("CONNECT_PROVIDER_REJECTED");
    }
    throw error;
  }
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

export const replaceClosedAccount = action({
  args: { country: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> =>
    await runConnectOnboardingAction(ctx, {
      country: args.country ?? null,
      forceFreshLink: false,
      requireExistingAccount: false,
      allowClosedReplacement: true,
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
    expectedLivemode: v.boolean(),
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
      profile.stripeConnectedAccountLivemode === undefined ||
      profile.stripeConnectedAccountLivemode !== args.expectedLivemode ||
      args.platformAccountId !== stripePlatformAccountId() ||
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
    providerRequestId?: string;
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
      await appendPublisherSettlementEntry(ctx, {
        balance,
        kind: "transfer_failed",
        availableDeltaAtoms: transfer.amountAtoms,
        allocatedDeltaAtoms: -transfer.amountAtoms,
        paidDeltaAtoms: 0,
        refId: `publisher:transfer:${transfer._id}:failed`,
        transferId: transfer._id,
      });
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
      providerRequestId: args.providerRequestId,
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
    providerRequestId: args.providerRequestId,
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
    transfer.providerRequestFingerprint !== undefined &&
    transfer.providerRequestFingerprint !==
      legacyProviderRequestFingerprint({
        amount: args.amount,
        currency: args.currency,
        destination: args.destination,
        publisherTransferId: String(transfer._id),
        correlationNonce: args.correlationNonce!,
        correlationHmac: args.correlationHmac!,
        platformAccountId: args.platformAccountId!,
      })
  ) {
    throw new Error("Stripe transfer request fingerprint changed");
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
    providerRequestId: v.optional(v.string()),
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
    if (transfer === null) {
      const now = Date.now();
      await ctx.db.insert("financeReconciliationCases", {
        kind: "transfer_orphan",
        status: "open",
        reason: "provider_transfer_without_local_allocation",
        candidateIds: [args.stripeTransferId],
        candidateCount: 1,
        providerRequestIds: [],
        attempts: 0,
        resolution: JSON.stringify({
          amount: args.amount,
          currency: args.currency,
          destination: args.destination,
          publisherTransferId: args.publisherTransferId ?? null,
        }),
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
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
      providerRequestId: args.providerRequestId,
      failed: args.failed,
      failureReason: args.failureReason,
    });
  },
});

export const markPublisherTransferRequiresReconciliation = internalMutation({
  args: { transferId: v.id("publisherTransfers"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null) return;
    const now = Date.now();
    let caseId = transfer.reconciliationCaseId;
    if (caseId === undefined) {
      caseId = await ctx.db.insert("financeReconciliationCases", {
        kind: "transfer",
        status: "open",
        reason: args.reason.slice(0, 120),
        organizationId: transfer.publisherOrganizationId,
        transferId: transfer._id,
        candidateIds:
          transfer.stripeTransferId === undefined
            ? []
            : [transfer.stripeTransferId],
        candidateCount: transfer.stripeTransferId === undefined ? 0 : 1,
        providerRequestIds:
          transfer.providerRequestId === undefined
            ? []
            : [transfer.providerRequestId],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(caseId, { attempts: 0, updatedAt: now });
    }
    await ctx.db.patch(transfer._id, {
      correlationState: "requires_reconciliation",
      providerOutcome: "ambiguous",
      reconciliationCaseId: caseId,
      updatedAt: now,
    });
  },
});

export const resolveFinanceReconciliationCase = internalMutation({
  args: {
    caseId: v.id("financeReconciliationCases"),
    status: v.union(
      v.literal("adopted"),
      v.literal("quarantined"),
      v.literal("resolved"),
      v.literal("open"),
    ),
    candidateIds: v.optional(v.array(v.string())),
    resolution: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.caseId);
    if (row === null) throw new Error("Finance reconciliation case not found");
    await ctx.db.patch(args.caseId, {
      status: args.status,
      candidateIds: args.candidateIds ?? row.candidateIds,
      candidateCount: (args.candidateIds ?? row.candidateIds).length,
      attempts: row.attempts + 1,
      resolution: args.resolution.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

export const recordDefinitivePublisherTransferFailure = internalMutation({
  args: { transferId: v.id("publisherTransfers"), code: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null || transfer.status === "failed") return;
    if (transfer.stripeTransferId !== undefined) {
      throw new Error(
        "Definitive failure cannot replace provider transfer proof",
      );
    }
    const balance = await getOrCreatePublisherBalance(
      ctx,
      transfer.publisherOrganizationId,
    );
    await appendPublisherSettlementEntry(ctx, {
      balance,
      kind: "transfer_failed",
      availableDeltaAtoms: transfer.amountAtoms,
      allocatedDeltaAtoms: -transfer.amountAtoms,
      paidDeltaAtoms: 0,
      refId: `publisher:transfer:${transfer._id}:failed`,
      transferId: transfer._id,
    });
    await adjustPublisherBalanceAggregates(ctx, balance, {
      failedAtoms: transfer.amountAtoms,
    });
    await ctx.db.patch(transfer._id, {
      status: "failed",
      failureReason: args.code.slice(0, 80),
      providerOutcome: "definitive_no_side_effect",
      correlationState: "provider_verified",
      attemptedAt: Date.now(),
      updatedAt: Date.now(),
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
  listCandidates?: (destination: string) => Promise<Stripe.Transfer[]>;
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

    const expectedLivemode = stripeLivemodeFromSecretKey(
      process.env.STRIPE_SECRET_KEY,
    );
    const stripe = stripeClient();
    await verifyStripePlatformIdentity(stripe, expectedLivemode);
    const platformAccountId = stripePlatformAccountId();

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
        platformAccountId,
        expectedLivemode,
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
        rows: earnings.map((earning) => {
          assertPublisherEarningReady(earning);
          return {
            id: earning._id,
            grossCredits: earning.grossCredits,
            platformFeeCredits: atomsToCredits(earning.platformFeeAtoms),
            netCredits: atomsToCredits(earning.publisherNetAtoms),
            clawedBackCredits: atomsToCredits(earning.clawedBackAtoms),
            availableAt: earning.availableAt,
            status: earning.status,
            createdAt: earning.createdAt,
          };
        }),
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
