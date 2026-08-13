/// <reference types="vite/client" />
import { signTransferCorrelation } from "@zevium/shared";
import { convexTest, type TestConvex } from "convex-test";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ACCOUNTING_ATOMS_PER_CREDIT,
  publisherEarningSplit,
} from "./accounting";
import {
  assertConnectedAccountIdentity,
  connectAccountProjection,
  connectOnboardingUrls,
  createAccountLinkForOperation,
  createAndRetrieveStripeTransfer,
  reconcileStripeTransferProvider,
  repairAndRetrieveStripeTransferMetadata,
  STRIPE_TRANSFER_SAFE_RETRY_MS,
  transferRequestFingerprint,
  createConnectedAccountForOperation,
  resolveConnectedAccountForOperation,
  runConnectOnboardingWorkflow,
  stripeLivemodeFromSecretKey,
  type ConnectOnboardingClient,
  type ConnectOnboardingWorkflowDependencies,
} from "./payouts";
import { FINANCE_MIGRATION_KEY } from "./lib/financeMigrationGate";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const TRANSFER_SECRET = "transfer-test-secret-32-bytes-minimum";
const TRANSFER_CORRELATION = {
  correlationNonce: "b".repeat(64),
  platformAccountId: "acct_platformtest",
} as const;
const ACCOUNT_OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const LINK_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REFRESH_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const TEST_NOW = Date.parse("2026-08-12T00:00:00.000Z");

function connectedAccountFixture(
  overrides: Partial<Stripe.V2.Core.Account> = {},
): Stripe.V2.Core.Account {
  return {
    id: "acct_V2Recipient123",
    object: "v2.core.account",
    applied_configurations: ["recipient"],
    configuration: {
      recipient: {
        applied: true,
        capabilities: {
          stripe_balance: {
            stripe_transfers: {},
          },
        },
      },
    },
    created: "2026-08-12T00:00:00.000Z",
    dashboard: "express",
    defaults: {
      responsibilities: {
        fees_collector: "application",
        losses_collector: "application",
        requirements_collector: "stripe",
      },
    },
    identity: { country: "ae" },
    livemode: false,
    metadata: {
      zevium_clerk_org_id: "org_publisher",
      zevium_connect_operation_id: ACCOUNT_OPERATION_ID,
      zevium_organization_id: "org_doc",
    },
    ...overrides,
  };
}

function accountLinkFixture(
  overrides: Partial<Stripe.V2.Core.AccountLink> = {},
): Stripe.V2.Core.AccountLink {
  return {
    object: "v2.core.account_link",
    account: "acct_V2Recipient123",
    created: "2026-08-12T00:00:00.000Z",
    expires_at: "2026-08-12T00:10:00.000Z",
    livemode: false,
    url: "https://connect.stripe.test/onboard-one",
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["recipient"],
        collection_options: {
          fields: "eventually_due",
          future_requirements: "include",
        },
        refresh_url: "https://zevium.test/app/earnings?onboarding=refresh",
        return_url: "https://zevium.test/app/earnings?onboarding=return",
      },
    },
    ...overrides,
  };
}

function connectClientFixture(
  overrides: {
    createAccount?: ConnectOnboardingClient["accountsV2"]["create"];
    retrieveAccount?: ConnectOnboardingClient["accountsV2"]["retrieve"];
    listRecipientAccounts?: ConnectOnboardingClient["accountsV2"]["listRecipientAccounts"];
    createLink?: ConnectOnboardingClient["accountLinksV2"]["create"];
  } = {},
): ConnectOnboardingClient {
  return {
    accountsV2: {
      create:
        overrides.createAccount ?? (async () => connectedAccountFixture()),
      retrieve:
        overrides.retrieveAccount ?? (async () => connectedAccountFixture()),
      listRecipientAccounts:
        overrides.listRecipientAccounts ?? (async () => []),
    },
    accountLinksV2: {
      create:
        overrides.createLink ??
        (async (params) =>
          accountLinkFixture({
            use_case: {
              type: "account_onboarding",
              account_onboarding: {
                configurations: ["recipient"],
                collection_options: {
                  fields: "eventually_due",
                  future_requirements: "include",
                },
                refresh_url:
                  params.use_case.account_onboarding?.refresh_url ?? "",
                return_url:
                  params.use_case.account_onboarding?.return_url ?? "",
              },
            },
          })),
    },
  };
}

type ConnectSeed = {
  organizationId: Id<"organizations">;
  earningId: Id<"publisherEarnings">;
};

async function seedConnect(t: TestConvex<typeof schema>): Promise<ConnectSeed> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_publisher",
      name: "Publisher",
      slug: "publisher",
    });
    await ctx.db.insert("organizationPayments", {
      organizationId,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: [],
      updatedAt: 1,
    });
    const split = publisherEarningSplit(110_000);
    const earningId = await ctx.db.insert("publisherEarnings", {
      publisherOrganizationId: organizationId,
      consumerOrganizationId: organizationId,
      usageSettlementRefId: "settle:publisher-one",
      grossCredits: split.grossCredits,
      platformFeeAtoms: split.platformFeeAtoms,
      publisherNetAtoms: split.publisherNetAtoms,
      platformFeeCredits: split.platformFeeCredits,
      netCredits: split.publisherNetCredits,
      clawedBackGrossCredits: 0,
      clawedBackAtoms: 0,
      releasedAtoms: 0,
      availableAt: 1,
      status: "pending_risk",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("publisherBalances", {
      publisherOrganizationId: organizationId,
      availableAtoms: 0,
      allocatedAtoms: 0,
      paidAtoms: 0,
      pendingRiskAtoms: split.publisherNetAtoms,
      reversedAtoms: 0,
      failedAtoms: 0,
      sequence: 0,
      migrationStatus: "verified",
      migrationWatermarkSequence: 0,
      updatedAt: 1,
    });
    return { organizationId, earningId };
  });
}

describe("Stripe Connect publisher accounting", () => {
  const previousSecret = process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
  const previousPlatform = process.env.STRIPE_PLATFORM_ACCOUNT_ID;

  beforeEach(() => {
    process.env.STRIPE_TRANSFER_CORRELATION_SECRET = TRANSFER_SECRET;
    process.env.STRIPE_PLATFORM_ACCOUNT_ID = "acct_platformtest";
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
    } else {
      process.env.STRIPE_TRANSFER_CORRELATION_SECRET = previousSecret;
    }
    if (previousPlatform === undefined) {
      delete process.env.STRIPE_PLATFORM_ACCOUNT_ID;
    } else {
      process.env.STRIPE_PLATFORM_ACCOUNT_ID = previousPlatform;
    }
  });
  it("rejects onboarding and transfers from an ordinary organization member", async () => {
    const t = convexTest(schema, modules);
    const member = t.withIdentity({
      subject: "user_member",
      org_id: "org_publisher",
      org_slug: "publisher",
      org_role: "org:member",
      email: "member@example.com",
    } as {
      subject: string;
      org_id: string;
      org_slug: string;
      org_role: string;
      email: string;
    });
    await expect(
      member.action(api.payouts.startOnboarding, {}),
    ).rejects.toThrow(/Org admin or owner role required/);
    await expect(
      member.action(api.payouts.initiatePublisherTransfer, {}),
    ).rejects.toThrow(/Org admin or owner role required/);
  });
  it("projects Accounts v2 recipient capability and requirements", () => {
    const projection = connectAccountProjection({
      id: "acct_recipient",
      object: "v2.core.account",
      configuration: {
        recipient: {
          applied: true,
          capabilities: {
            stripe_balance: {
              payouts: { status: "restricted", status_details: [] },
              stripe_transfers: {
                status: "active",
                status_details: [],
              },
            },
          },
        },
      },
      requirements: {
        entries: [
          {
            awaiting_action_from: "user",
            description: "external_account",
            errors: [],
            impact: { restricts_capabilities: [] },
            minimum_deadline: { status: "past_due" },
            requested_reason: "routine_onboarding",
          },
        ],
        summary: { minimum_deadline: { status: "past_due" } },
      },
    } as Stripe.V2.Core.Account);

    expect(projection).toEqual({
      chargesEnabled: false,
      detailsSubmitted: false,
      disabledReason: "Transfers: active; payouts: restricted",
      payoutsEnabled: false,
      requirements: ["external_account"],
    });
  });

  it("uses exact Accounts v2 recipient and Account Links v2 onboarding calls", async () => {
    const accountCalls: Array<{
      params: Stripe.V2.Core.AccountCreateParams;
      options?: Stripe.RequestOptions;
    }> = [];
    const linkCalls: Array<{
      params: Stripe.V2.Core.AccountLinkCreateParams;
      options?: Stripe.RequestOptions;
    }> = [];
    const client = connectClientFixture({
      createAccount: async (params, options) => {
        accountCalls.push({ params, options });
        return connectedAccountFixture();
      },
      createLink: async (params, options) => {
        linkCalls.push({ params, options });
        return accountLinkFixture();
      },
    });
    const account = await createConnectedAccountForOperation(client, {
      operationId: ACCOUNT_OPERATION_ID,
      clerkOrgId: "org_publisher",
      organizationId: "org_doc",
      organizationName: "Publisher",
      country: "AE",
      contactEmail: "publisher@example.com",
      expectedLivemode: false,
    });
    const link = await createAccountLinkForOperation(client, {
      operationId: LINK_OPERATION_ID,
      connectedAccountId: account.id,
      expectedLivemode: false,
      refreshUrl: "https://zevium.test/app/earnings?onboarding=refresh",
      returnUrl: "https://zevium.test/app/earnings?onboarding=return",
    });

    expect(link.url).toBe("https://connect.stripe.test/onboard-one");
    expect(accountCalls).toEqual([
      {
        params: {
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
          contact_email: "publisher@example.com",
          display_name: "Publisher",
          identity: { country: "ae" },
          include: [
            "configuration.recipient",
            "defaults",
            "identity",
            "requirements",
          ],
          metadata: {
            zevium_clerk_org_id: "org_publisher",
            zevium_connect_operation_id: ACCOUNT_OPERATION_ID,
            zevium_organization_id: "org_doc",
          },
        },
        options: {
          idempotencyKey: `zevium-connect-account:${ACCOUNT_OPERATION_ID}`,
        },
      },
    ]);
    expect(linkCalls).toEqual([
      {
        params: {
          account: "acct_V2Recipient123",
          use_case: {
            type: "account_onboarding",
            account_onboarding: {
              configurations: ["recipient"],
              collection_options: {
                fields: "eventually_due",
                future_requirements: "include",
              },
              refresh_url:
                "https://zevium.test/app/earnings?onboarding=refresh",
              return_url: "https://zevium.test/app/earnings?onboarding=return",
            },
          },
        },
        options: {
          idempotencyKey: `zevium-connect-link:${LINK_OPERATION_ID}`,
        },
      },
    ]);
  });

  it("requires explicit Stripe mode and HTTPS onboarding URLs", () => {
    expect(stripeLivemodeFromSecretKey("sk_test_example")).toBe(false);
    expect(stripeLivemodeFromSecretKey("rk_test_example")).toBe(false);
    expect(stripeLivemodeFromSecretKey("sk_live_example")).toBe(true);
    expect(stripeLivemodeFromSecretKey("rk_live_example")).toBe(true);
    expect(() => stripeLivemodeFromSecretKey("opaque-secret")).toThrow(
      "must identify Stripe test or live mode",
    );
    expect(connectOnboardingUrls("https://zevium.test/path")).toEqual({
      refreshUrl: "https://zevium.test/app/earnings?onboarding=refresh",
      returnUrl: "https://zevium.test/app/earnings?onboarding=return",
    });
    expect(() => connectOnboardingUrls("http://localhost:5173")).toThrow(
      "must use HTTPS",
    );
  });

  it("rejects wrong connected-account identity and test/live mode", async () => {
    expect(() =>
      assertConnectedAccountIdentity(
        connectedAccountFixture({
          metadata: {
            zevium_clerk_org_id: "org_attacker",
            zevium_connect_operation_id: ACCOUNT_OPERATION_ID,
            zevium_organization_id: "org_doc",
          },
        }),
        {
          accountId: "acct_V2Recipient123",
          clerkOrgId: "org_publisher",
          organizationId: "org_doc",
          expectedLivemode: false,
        },
      ),
    ).toThrow("organization does not match");
    expect(() =>
      assertConnectedAccountIdentity(
        connectedAccountFixture({ livemode: true }),
        {
          accountId: "acct_V2Recipient123",
          clerkOrgId: "org_publisher",
          organizationId: "org_doc",
          expectedLivemode: false,
        },
      ),
    ).toThrow("mode does not match");

    await expect(
      createAccountLinkForOperation(
        connectClientFixture({
          createLink: async () =>
            accountLinkFixture({ account: "acct_Other123" }),
        }),
        {
          operationId: LINK_OPERATION_ID,
          connectedAccountId: "acct_V2Recipient123",
          expectedLivemode: false,
          refreshUrl: "https://zevium.test/refresh",
          returnUrl: "https://zevium.test/return",
        },
      ),
    ).rejects.toThrow("another account");
    await expect(
      createAccountLinkForOperation(
        connectClientFixture({
          createLink: async () => accountLinkFixture({ livemode: true }),
        }),
        {
          operationId: LINK_OPERATION_ID,
          connectedAccountId: "acct_V2Recipient123",
          expectedLivemode: false,
          refreshUrl: "https://zevium.test/refresh",
          returnUrl: "https://zevium.test/return",
        },
      ),
    ).rejects.toThrow("mode does not match");
  });

  it("reuses one link operation but gives refresh a new single-use link", async () => {
    const linksByIdempotencyKey = new Map<string, Stripe.V2.Core.AccountLink>();
    const idempotencyKeys: string[] = [];
    const client = connectClientFixture({
      createLink: async (params, options) => {
        const idempotencyKey = options?.idempotencyKey;
        if (idempotencyKey === undefined) {
          throw new Error("missing idempotency key");
        }
        idempotencyKeys.push(idempotencyKey);
        const existing = linksByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return existing;
        const link = accountLinkFixture({
          account: params.account,
          url: `https://connect.stripe.test/${linksByIdempotencyKey.size + 1}`,
          use_case: params.use_case,
        });
        linksByIdempotencyKey.set(idempotencyKey, link);
        return link;
      },
    });
    const args = {
      operationId: LINK_OPERATION_ID,
      connectedAccountId: "acct_V2Recipient123",
      expectedLivemode: false,
      refreshUrl: "https://zevium.test/refresh",
      returnUrl: "https://zevium.test/return",
    } as const;
    const first = await createAccountLinkForOperation(client, args);
    const sameOperationRetry = await createAccountLinkForOperation(
      client,
      args,
    );
    const refresh = await createAccountLinkForOperation(client, {
      ...args,
      operationId: REFRESH_OPERATION_ID,
    });

    expect(sameOperationRetry.url).toBe(first.url);
    expect(refresh.url).not.toBe(first.url);
    expect(linksByIdempotencyKey.size).toBe(2);
    expect(idempotencyKeys).toEqual([
      `zevium-connect-link:${LINK_OPERATION_ID}`,
      `zevium-connect-link:${LINK_OPERATION_ID}`,
      `zevium-connect-link:${REFRESH_OPERATION_ID}`,
    ]);
  });

  it("replays the same account operation while v2 list visibility lags", async () => {
    const accountsByIdempotencyKey = new Map<string, Stripe.V2.Core.Account>();
    const idempotencyKeys: string[] = [];
    const client = connectClientFixture({
      listRecipientAccounts: async () => [],
      createAccount: async (_params, options) => {
        const idempotencyKey = options?.idempotencyKey;
        if (idempotencyKey === undefined) {
          throw new Error("missing idempotency key");
        }
        idempotencyKeys.push(idempotencyKey);
        const existing = accountsByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return existing;
        const account = connectedAccountFixture();
        accountsByIdempotencyKey.set(idempotencyKey, account);
        return account;
      },
    });
    const args = {
      operationId: ACCOUNT_OPERATION_ID,
      clerkOrgId: "org_publisher",
      organizationId: "org_doc",
      organizationName: "Publisher",
      country: "AE",
      contactEmail: "publisher@example.com",
      expectedLivemode: false,
      reconcileFirst: true,
      operationStartedAt: TEST_NOW,
      now: TEST_NOW + 1_000,
    } as const;
    const first = await resolveConnectedAccountForOperation(client, args);
    const retry = await resolveConnectedAccountForOperation(client, args);

    expect(retry.id).toBe(first.id);
    expect(accountsByIdempotencyKey.size).toBe(1);
    expect(idempotencyKeys).toEqual([
      `zevium-connect-account:${ACCOUNT_OPERATION_ID}`,
      `zevium-connect-account:${ACCOUNT_OPERATION_ID}`,
    ]);
  });

  it("recovers account-create crash before local write without duplicating provider account", async () => {
    const organizationId = "org_doc" as Id<"organizations">;
    const providerAccount = connectedAccountFixture();
    const events: string[] = [];
    let accountPersisted = false;
    let providerAccountCreated = false;
    let commitAttempts = 0;
    const client = connectClientFixture({
      createAccount: async () => {
        events.push("provider-account-create");
        providerAccountCreated = true;
        return providerAccount;
      },
      listRecipientAccounts: async () => {
        events.push("provider-account-list");
        return providerAccountCreated ? [providerAccount] : [];
      },
      retrieveAccount: async () => {
        events.push("provider-account-retrieve");
        return providerAccount;
      },
      createLink: async (params) => {
        events.push("provider-link-create");
        return accountLinkFixture({
          use_case: {
            type: "account_onboarding",
            account_onboarding: {
              configurations: ["recipient"],
              collection_options: {
                fields: "eventually_due",
                future_requirements: "include",
              },
              refresh_url:
                params.use_case.account_onboarding?.refresh_url ?? "",
              return_url: params.use_case.account_onboarding?.return_url ?? "",
            },
          },
        });
      },
    });
    const store: ConnectOnboardingWorkflowDependencies["store"] = {
      prepareAccount: async () => ({
        organizationId,
        organizationName: "Publisher",
        connectedAccountId: accountPersisted ? providerAccount.id : null,
        connectedAccountLivemode: accountPersisted ? false : null,
        operation: accountPersisted
          ? null
          : {
              operationId: ACCOUNT_OPERATION_ID,
              country: "AE",
              contactEmail: "publisher@example.com",
              startedAt: TEST_NOW,
              isRetry: commitAttempts > 0,
            },
      }),
      commitAccount: async () => {
        commitAttempts += 1;
        events.push("local-account-commit");
        if (commitAttempts === 1) {
          throw new Error("simulated local write crash");
        }
        accountPersisted = true;
        return { accepted: true, connectedAccountId: providerAccount.id };
      },
      confirmAccount: async () => undefined,
      prepareLink: async () => {
        expect(accountPersisted).toBe(true);
        events.push("local-link-prepare");
        return {
          operationId: LINK_OPERATION_ID,
          connectedAccountId: providerAccount.id,
          expectedLivemode: false,
          isRetry: false,
        };
      },
      expireLink: async () => undefined,
      completeLink: async () => {
        events.push("local-link-complete");
        return true;
      },
    };
    const dependencies: ConnectOnboardingWorkflowDependencies = {
      stripe: client,
      store,
      expectedLivemode: false,
      refreshUrl: "https://zevium.test/refresh",
      returnUrl: "https://zevium.test/return",
      newOperationId: () => LINK_OPERATION_ID,
      now: () => TEST_NOW,
    };
    const actor = {
      clerkOrgId: "org_publisher",
      contactEmail: "publisher@example.com",
    };
    const input = {
      country: "AE",
      forceFreshLink: false,
      requireExistingAccount: false,
    };

    await expect(
      runConnectOnboardingWorkflow(actor, input, dependencies),
    ).rejects.toThrow("simulated local write crash");
    const result = await runConnectOnboardingWorkflow(
      actor,
      input,
      dependencies,
    );

    expect(result.url).toBe("https://connect.stripe.test/onboard-one");
    expect(
      events.filter((event) => event === "provider-account-create"),
    ).toHaveLength(1);
    expect(events.indexOf("local-account-commit")).toBeLessThan(
      events.indexOf("provider-link-create"),
    );
  });

  it("replays one link operation after provider response crashes before local completion", async () => {
    const organizationId = "org_doc" as Id<"organizations">;
    const linksByIdempotencyKey = new Map<string, Stripe.V2.Core.AccountLink>();
    const linkCalls: string[] = [];
    let completeAttempts = 0;
    const client = connectClientFixture({
      createLink: async (params, options) => {
        const idempotencyKey = options?.idempotencyKey;
        if (idempotencyKey === undefined) {
          throw new Error("missing idempotency key");
        }
        linkCalls.push(idempotencyKey);
        const existing = linksByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return existing;
        const link = accountLinkFixture({
          account: params.account,
          use_case: params.use_case,
        });
        linksByIdempotencyKey.set(idempotencyKey, link);
        return link;
      },
    });
    const store: ConnectOnboardingWorkflowDependencies["store"] = {
      prepareAccount: async () => ({
        organizationId,
        organizationName: "Publisher",
        connectedAccountId: "acct_V2Recipient123",
        connectedAccountLivemode: false,
        operation: null,
      }),
      commitAccount: async () => {
        throw new Error("account already persisted");
      },
      confirmAccount: async () => undefined,
      prepareLink: async () => ({
        operationId: LINK_OPERATION_ID,
        connectedAccountId: "acct_V2Recipient123",
        expectedLivemode: false,
        isRetry: completeAttempts > 0,
      }),
      expireLink: async () => undefined,
      completeLink: async () => {
        completeAttempts += 1;
        if (completeAttempts === 1) {
          throw new Error("simulated link completion crash");
        }
        return true;
      },
    };
    const dependencies: ConnectOnboardingWorkflowDependencies = {
      stripe: client,
      store,
      expectedLivemode: false,
      refreshUrl: "https://zevium.test/refresh",
      returnUrl: "https://zevium.test/return",
      newOperationId: () => LINK_OPERATION_ID,
      now: () => TEST_NOW,
    };
    const actor = {
      clerkOrgId: "org_publisher",
      contactEmail: "publisher@example.com",
    };
    const input = {
      country: null,
      forceFreshLink: false,
      requireExistingAccount: false,
    };

    await expect(
      runConnectOnboardingWorkflow(actor, input, dependencies),
    ).rejects.toThrow("simulated link completion crash");
    await expect(
      runConnectOnboardingWorkflow(actor, input, dependencies),
    ).resolves.toEqual({ url: "https://connect.stripe.test/onboard-one" });
    expect(linksByIdempotencyKey.size).toBe(1);
    expect(linkCalls).toEqual([
      `zevium-connect-link:${LINK_OPERATION_ID}`,
      `zevium-connect-link:${LINK_OPERATION_ID}`,
    ]);
  });

  it("adopts a 5f8-era create-before-link orphan instead of creating another account", async () => {
    const legacyAccount = connectedAccountFixture({
      id: "acct_LegacyRecipient123",
      metadata: { clerkOrgId: "org_publisher" },
    });
    let accountCreates = 0;
    const resolved = await resolveConnectedAccountForOperation(
      connectClientFixture({
        createAccount: async () => {
          accountCreates += 1;
          return connectedAccountFixture();
        },
        listRecipientAccounts: async () => [legacyAccount],
        retrieveAccount: async () => legacyAccount,
      }),
      {
        operationId: ACCOUNT_OPERATION_ID,
        clerkOrgId: "org_publisher",
        organizationId: "org_doc",
        organizationName: "Publisher",
        country: "AE",
        contactEmail: "publisher@example.com",
        expectedLivemode: false,
        reconcileFirst: true,
        operationStartedAt: TEST_NOW,
        now: TEST_NOW,
      },
    );
    expect(resolved.id).toBe("acct_LegacyRecipient123");
    expect(accountCreates).toBe(0);
  });

  it("fails closed after v2 replay window when bounded reconciliation finds nothing", async () => {
    let accountCreates = 0;
    await expect(
      resolveConnectedAccountForOperation(
        connectClientFixture({
          createAccount: async () => {
            accountCreates += 1;
            return connectedAccountFixture();
          },
          listRecipientAccounts: async () => [],
        }),
        {
          operationId: ACCOUNT_OPERATION_ID,
          clerkOrgId: "org_publisher",
          organizationId: "org_doc",
          organizationName: "Publisher",
          country: "AE",
          contactEmail: "publisher@example.com",
          expectedLivemode: false,
          reconcileFirst: true,
          operationStartedAt: TEST_NOW - 30 * 24 * 60 * 60 * 1_000,
          now: TEST_NOW,
        },
      ),
    ).rejects.toThrow("reconciliation is required");
    expect(accountCreates).toBe(0);
  });

  it("fails closed when the bounded reconciliation scan is saturated", async () => {
    const visibleMatch = connectedAccountFixture();
    const saturatedAccounts = Array.from({ length: 1_000 }, (_, index) =>
      index === 0
        ? visibleMatch
        : connectedAccountFixture({
            id: `acct_Unrelated${index}`,
            metadata: {
              zevium_clerk_org_id: `org_unrelated_${index}`,
              zevium_connect_operation_id:
                "44444444-4444-4444-8444-444444444444",
              zevium_organization_id: `org_doc_${index}`,
            },
          }),
    );
    let accountCreates = 0;
    await expect(
      resolveConnectedAccountForOperation(
        connectClientFixture({
          createAccount: async () => {
            accountCreates += 1;
            return connectedAccountFixture();
          },
          listRecipientAccounts: async () => saturatedAccounts,
        }),
        {
          operationId: ACCOUNT_OPERATION_ID,
          clerkOrgId: "org_publisher",
          organizationId: "org_doc",
          organizationName: "Publisher",
          country: "AE",
          contactEmail: "publisher@example.com",
          expectedLivemode: false,
          reconcileFirst: true,
          operationStartedAt: TEST_NOW,
          now: TEST_NOW,
        },
      ),
    ).rejects.toThrow("reconciliation scan is full");
    expect(accountCreates).toBe(0);
  });

  it("persists durable account and link operations across crash windows", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    const first = await t.mutation(
      internal.payouts.prepareConnectAccountOperation,
      {
        clerkOrgId: "org_publisher",
        candidateOperationId: ACCOUNT_OPERATION_ID,
        expectedLivemode: false,
        country: "AE",
        contactEmail: "publisher@example.com",
        requireExistingAccount: false,
      },
    );
    const retry = await t.mutation(
      internal.payouts.prepareConnectAccountOperation,
      {
        clerkOrgId: "org_publisher",
        candidateOperationId: "44444444-4444-4444-8444-444444444444",
        expectedLivemode: false,
        country: "US",
        contactEmail: "changed@example.com",
        requireExistingAccount: false,
      },
    );
    expect(retry.operation).toEqual({
      ...first.operation,
      isRetry: true,
    });
    await expect(
      t.mutation(internal.payouts.prepareConnectLinkOperation, {
        organizationId: seed.organizationId,
        candidateOperationId: LINK_OPERATION_ID,
        expectedLivemode: false,
        forceFresh: false,
      }),
    ).rejects.toThrow("must be persisted before onboarding");

    const committed = await t.mutation(
      internal.payouts.commitConnectAccountOperation,
      {
        organizationId: seed.organizationId,
        operationId: ACCOUNT_OPERATION_ID,
        stripeConnectedAccountId: "acct_V2Recipient123",
        expectedLivemode: false,
      },
    );
    expect(committed).toEqual({
      accepted: true,
      connectedAccountId: "acct_V2Recipient123",
    });
    const link = await t.mutation(
      internal.payouts.prepareConnectLinkOperation,
      {
        organizationId: seed.organizationId,
        candidateOperationId: LINK_OPERATION_ID,
        expectedLivemode: false,
        forceFresh: false,
      },
    );
    const linkRetry = await t.mutation(
      internal.payouts.prepareConnectLinkOperation,
      {
        organizationId: seed.organizationId,
        candidateOperationId: REFRESH_OPERATION_ID,
        expectedLivemode: false,
        forceFresh: false,
      },
    );
    expect(linkRetry).toEqual({ ...link, isRetry: true });
    expect(
      await t.mutation(internal.payouts.completeConnectLinkOperation, {
        organizationId: seed.organizationId,
        operationId: link.operationId,
        stripeConnectedAccountId: link.connectedAccountId,
        expectedLivemode: false,
        providerExpiresAt: TEST_NOW + 10 * 60 * 1_000,
      }),
    ).toBe(true);
    const refresh = await t.mutation(
      internal.payouts.prepareConnectLinkOperation,
      {
        organizationId: seed.organizationId,
        candidateOperationId: REFRESH_OPERATION_ID,
        expectedLivemode: false,
        forceFresh: true,
      },
    );
    expect(refresh.operationId).toBe(REFRESH_OPERATION_ID);
    expect(refresh.operationId).not.toBe(link.operationId);
    const state = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
      operations: await ctx.db
        .query("stripeConnectOnboardingOperations")
        .collect(),
    }));
    expect(state.profile).toMatchObject({
      stripeConnectedAccountId: "acct_V2Recipient123",
      stripeConnectedAccountLivemode: false,
    });
    expect(
      state.operations.map((operation) => operation.status).sort(),
    ).toEqual(["account_persisted", "link_created", "prepared"]);
  });

  it("records create-before-write ambiguity without replacing or closing real account", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.prepareConnectAccountOperation, {
      clerkOrgId: "org_publisher",
      candidateOperationId: ACCOUNT_OPERATION_ID,
      expectedLivemode: false,
      country: "AE",
      contactEmail: "publisher@example.com",
      requireExistingAccount: false,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, {
        stripeConnectedAccountId: "acct_RealPublisher123",
        stripeConnectedAccountLivemode: false,
      });
    });
    expect(
      await t.mutation(internal.payouts.commitConnectAccountOperation, {
        organizationId: seed.organizationId,
        operationId: ACCOUNT_OPERATION_ID,
        stripeConnectedAccountId: "acct_AmbiguousCandidate123",
        expectedLivemode: false,
      }),
    ).toEqual({
      accepted: false,
      connectedAccountId: "acct_RealPublisher123",
    });
    const state = await t.run(async (ctx) => ({
      profile: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
      operation: await ctx.db
        .query("stripeConnectOnboardingOperations")
        .withIndex("by_operation", (q) =>
          q.eq("operationId", ACCOUNT_OPERATION_ID),
        )
        .unique(),
    }));
    expect(state.profile?.stripeConnectedAccountId).toBe(
      "acct_RealPublisher123",
    );
    expect(state.operation).toMatchObject({
      status: "requires_reconciliation",
      stripeConnectedAccountId: "acct_AmbiguousCandidate123",
    });
  });

  it("splits every call exactly in atom units without rounding theft", () => {
    expect([0, 1, 19, 20].map(publisherEarningSplit)).toEqual([
      {
        grossCredits: 0,
        platformFeeAtoms: 0,
        publisherNetAtoms: 0,
        platformFeeCredits: 0,
        publisherNetCredits: 0,
      },
      {
        grossCredits: 1,
        platformFeeAtoms: 500,
        publisherNetAtoms: 9_500,
        platformFeeCredits: 0.05,
        publisherNetCredits: 0.95,
      },
      {
        grossCredits: 19,
        platformFeeAtoms: 9_500,
        publisherNetAtoms: 180_500,
        platformFeeCredits: 0.95,
        publisherNetCredits: 18.05,
      },
      {
        grossCredits: 20,
        platformFeeAtoms: 10_000,
        publisherNetAtoms: 190_000,
        platformFeeCredits: 1,
        publisherNetCredits: 19,
      },
    ]);
    expect(publisherEarningSplit(100_001)).toEqual({
      grossCredits: 100_001,
      platformFeeAtoms: 50_000_500,
      publisherNetAtoms: 950_009_500,
      platformFeeCredits: 5_000.05,
      publisherNetCredits: 95_000.95,
    });
    for (let credits = 0; credits < 10_000; credits += 17) {
      const split = publisherEarningSplit(credits);
      expect(split.platformFeeAtoms + split.publisherNetAtoms).toBe(
        credits * ACCOUNTING_ATOMS_PER_CREDIT,
      );
      expect(split.platformFeeAtoms * 19).toBe(split.publisherNetAtoms);
    }
    expect(() => publisherEarningSplit(-1)).toThrow("non-negative");
  });

  it("reuses a connected account and projects account.updated state", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    expect(
      await t.mutation(internal.payouts.setConnectedAccount, {
        organizationId: seed.organizationId,
        stripeConnectedAccountId: "acct_reused",
        expectedLivemode: false,
      }),
    ).toBe("acct_reused");
    expect(
      await t.mutation(internal.payouts.setConnectedAccount, {
        organizationId: seed.organizationId,
        stripeConnectedAccountId: "acct_other",
        expectedLivemode: false,
      }),
    ).toBe("acct_reused");
    await t.mutation(internal.payouts.projectConnectedAccount, {
      stripeConnectedAccountId: "acct_reused",
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: true,
      disabledReason: undefined,
      requirements: ["external_account", "external_account"],
    });
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique(),
    );
    expect(profile).toMatchObject({
      stripeConnectedAccountId: "acct_reused",
      detailsSubmitted: true,
      payoutsEnabled: true,
      requirements: ["external_account"],
    });
  });

  it("blocks members from onboarding or transferring before any local side effect", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        clerkOrgId: "org_member_blocked",
        name: "Member blocked",
        slug: "member-blocked",
      }),
    );
    const member = t.withIdentity({
      subject: "member_user",
      org_id: "org_member_blocked",
      org_role: "org:member",
      email: "member@example.com",
    } as {
      subject: string;
      org_id: string;
      org_role: string;
      email: string;
    });
    await expect(
      member.action(api.payouts.startOnboarding, { country: "US" }),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      member.action(api.payouts.refreshOnboarding, {}),
    ).rejects.toThrow("Org admin or owner role required");
    await expect(
      member.action(api.payouts.initiatePublisherTransfer, {}),
    ).rejects.toThrow("Org admin or owner role required");
    const state = await t.run(async (ctx) => ({
      profiles: await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", organizationId),
        )
        .collect(),
      transfers: await ctx.db
        .query("publisherTransfers")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", organizationId),
        )
        .collect(),
    }));
    expect(state).toEqual({ profiles: [], transfers: [] });
  });

  it("enforces capability gates and creates one idempotent transfer allocation", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_transfer",
      expectedLivemode: false,
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      }),
    ).rejects.toThrow("not eligible");
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true, updatedAt: 2 });
      await ctx.db.patch(seed.earningId, {
        status: "pending_risk",
        availableAt: Date.now() + 60_000,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      }),
    ).rejects.toThrow("$10.00 payout minimum");
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.earningId, {
        status: "pending_risk",
        availableAt: 1,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const [first, retry] = await Promise.all([
      t.mutation(internal.payouts.preparePublisherTransfer, {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      }),
      t.mutation(internal.payouts.preparePublisherTransfer, {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      }),
    ]);
    expect(retry.transferId).toBe(first.transferId);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.amount).toBe(1_045);
    const prepared = await t.run(async (ctx) => ({
      transfer: await ctx.db.get(first.transferId),
      dispatch: await ctx.db
        .query("publisherTransferDispatches")
        .withIndex("by_transfer", (q) => q.eq("transferId", first.transferId))
        .unique(),
      ledger: await ctx.db
        .query("publisherSettlementEntries")
        .withIndex("by_transfer_sequence", (q) =>
          q.eq("transferId", first.transferId),
        )
        .collect(),
    }));
    expect(prepared.transfer).toMatchObject({
      correlationState: "local_prepared",
      metadataRepairVersion: 2,
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(prepared.dispatch).toMatchObject({
      state: "prepared",
      attemptCount: 0,
      requestFingerprint: prepared.transfer?.requestFingerprint,
    });
    expect(prepared.ledger.map((entry) => entry.kind)).toEqual([
      "transfer_allocation",
    ]);
    const claims = await Promise.all([
      t.mutation(internal.payouts.claimPublisherTransferDispatch, {
        transferId: first.transferId,
      }),
      t.mutation(internal.payouts.claimPublisherTransferDispatch, {
        transferId: first.transferId,
      }),
    ]);
    expect(claims.map((claim) => claim.mode).sort()).toEqual([
      "busy",
      "create",
    ]);
    const createClaim = claims.find((claim) => claim.mode === "create");
    if (createClaim?.mode !== "create") throw new Error("create claim missing");
    await t.run(async (ctx) => {
      const dispatch = await ctx.db
        .query("publisherTransferDispatches")
        .withIndex("by_transfer", (q) => q.eq("transferId", first.transferId))
        .unique();
      if (dispatch === null) throw new Error("dispatch missing");
      await ctx.db.patch(dispatch._id, { leaseExpiresAt: 0 });
    });
    expect(
      await t.mutation(internal.payouts.recoverPublisherTransferDispatches, {}),
    ).toEqual({ scheduled: 1 });
    const recovered = await t.mutation(
      internal.payouts.claimPublisherTransferDispatch,
      { transferId: first.transferId },
    );
    expect(recovered).toMatchObject({
      mode: "reconcile",
      allowCreateAfterNoMatch: true,
      firstAttemptAt: createClaim.firstAttemptAt,
      requestFingerprint: first.requestFingerprint,
    });
  });

  it("carries sub-cent earnings into the next transfer", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_carry",
      expectedLivemode: false,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
      const split = publisherEarningSplit(110_001);
      await ctx.db.patch(seed.earningId, {
        grossCredits: split.grossCredits,
        platformFeeAtoms: split.platformFeeAtoms,
        publisherNetAtoms: split.publisherNetAtoms,
        platformFeeCredits: split.platformFeeCredits,
        netCredits: split.publisherNetCredits,
      });
      const balance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique();
      if (balance === null) throw new Error("balance missing");
      await ctx.db.patch(balance._id, {
        pendingRiskAtoms: split.publisherNetAtoms,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });

    const first = await t.mutation(internal.payouts.preparePublisherTransfer, {
      expectedLivemode: false,
      publisherOrganizationId: seed.organizationId,
      ...TRANSFER_CORRELATION,
    });
    expect(first.amount).toBe(1_045);
    expect(first.remainderAtoms).toBe(9_500);
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_carry_first",
      publisherTransferId: first.transferId,
      amount: first.amount,
      amountReversed: 0,
      currency: first.currency,
      destination: first.connectedAccountId,
      platformAccountId: first.platformAccountId,
      correlationNonce: first.correlationNonce,
      correlationHmac: first.correlationHmac,
      metadataRepairVersion: 2,
      requestFingerprint: first.requestFingerprint,
      failed: false,
    });
    await expect(
      t.mutation(internal.payouts.preparePublisherTransfer, {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      }),
    ).rejects.toThrow("$10.00 payout minimum");
    await t.run(async (ctx) => {
      const split = publisherEarningSplit(105_263);
      await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: seed.organizationId,
        consumerOrganizationId: seed.organizationId,
        usageSettlementRefId: "settle:publisher-carry",
        grossCredits: split.grossCredits,
        platformFeeAtoms: split.platformFeeAtoms,
        publisherNetAtoms: split.publisherNetAtoms,
        platformFeeCredits: split.platformFeeCredits,
        netCredits: split.publisherNetCredits,
        clawedBackGrossCredits: 0,
        clawedBackAtoms: 0,
        releasedAtoms: 0,
        availableAt: 1,
        status: "pending_risk",
        createdAt: 2,
        updatedAt: 2,
      });
      const balance = await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique();
      if (balance === null) throw new Error("balance missing");
      await ctx.db.patch(balance._id, {
        pendingRiskAtoms: balance.pendingRiskAtoms + split.publisherNetAtoms,
      });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });

    const second = await t.mutation(internal.payouts.preparePublisherTransfer, {
      expectedLivemode: false,
      publisherOrganizationId: seed.organizationId,
      ...TRANSFER_CORRELATION,
    });
    expect(second.amount).toBe(1_000);
    expect(second.remainderAtoms).toBe(8_000);
  });

  it("projects failed/reversed transfers and payout state without changing earnings twice", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_projection",
      expectedLivemode: false,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const transfer = await t.mutation(
      internal.payouts.preparePublisherTransfer,
      {
        expectedLivemode: false,
        publisherOrganizationId: seed.organizationId,
        ...TRANSFER_CORRELATION,
      },
    );
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_projection",
      publisherTransferId: transfer.transferId,
      amount: transfer.amount,
      amountReversed: 0,
      currency: transfer.currency,
      destination: transfer.connectedAccountId,
      platformAccountId: transfer.platformAccountId,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      metadataRepairVersion: 2,
      requestFingerprint: transfer.requestFingerprint,
      failed: false,
    });
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_projection",
      amount: transfer.amount,
      amountReversed: 0,
      currency: transfer.currency,
      destination: transfer.connectedAccountId,
      platformAccountId: transfer.platformAccountId,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      metadataRepairVersion: 2,
      requestFingerprint: transfer.requestFingerprint,
      failed: true,
      failureReason: "stale failure",
    });
    await t.mutation(internal.payouts.projectStripeTransfer, {
      stripeTransferId: "tr_projection",
      amount: transfer.amount,
      amountReversed: transfer.amount,
      currency: transfer.currency,
      destination: transfer.connectedAccountId,
      platformAccountId: transfer.platformAccountId,
      correlationNonce: transfer.correlationNonce,
      correlationHmac: transfer.correlationHmac,
      metadataRepairVersion: 2,
      requestFingerprint: transfer.requestFingerprint,
      failed: false,
      failureReason: undefined,
    });
    await t.mutation(internal.payouts.projectConnectedPayout, {
      stripeConnectedAccountId: "acct_projection",
      stripePayoutId: "po_projection",
      amount: 950,
      currency: "usd",
      status: "paid",
      failureCode: undefined,
      arrivalDate: 1000,
    });
    await t.mutation(internal.payouts.projectConnectedPayout, {
      stripeConnectedAccountId: "acct_projection",
      stripePayoutId: "po_projection",
      amount: 950,
      currency: "usd",
      status: "paid",
      failureCode: undefined,
      arrivalDate: 1000,
    });
    const state = await t.run(async (ctx) => ({
      earning: await ctx.db.get(seed.earningId),
      transfer: await ctx.db.get(transfer.transferId),
      payouts: await ctx.db.query("connectedPayouts").collect(),
      balance: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique(),
      ledger: await ctx.db.query("publisherSettlementEntries").collect(),
    }));
    expect(state.earning?.status).toBe("available");
    expect(state.transfer?.status).toBe("reversed");
    expect(state.balance).toMatchObject({
      availableAtoms: 1_045_000_000,
      allocatedAtoms: 0,
      paidAtoms: 0,
    });
    expect(state.ledger.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "transfer_allocation",
      "transfer_succeeded",
      "transfer_reversal",
    ]);
    expect(state.payouts).toHaveLength(1);
    const publicState = await t
      .withIdentity({ subject: "publisher", org_id: "org_publisher" } as {
        subject: string;
        org_id: string;
      })
      .query(api.payouts.getPayoutState, {});
    expect(publicState.transfers).toEqual([
      expect.objectContaining({
        id: transfer.transferId,
        status: "reversed",
        stripeTransferId: "tr_projection",
      }),
    ]);
  });

  it("correlates reversal metadata across local-write crash and keeps retry projection reversed", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedConnect(t);
    await t.mutation(internal.payouts.setConnectedAccount, {
      organizationId: seed.organizationId,
      stripeConnectedAccountId: "acct_crash",
      expectedLivemode: false,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("organizationPayments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", seed.organizationId),
        )
        .unique();
      if (profile === null) throw new Error("profile missing");
      await ctx.db.patch(profile._id, { payoutsEnabled: true });
    });
    await t.mutation(internal.payouts.releaseMatureEarnings, {
      publisherOrganizationId: seed.organizationId,
    });
    const local = await t.mutation(internal.payouts.preparePublisherTransfer, {
      expectedLivemode: false,
      publisherOrganizationId: seed.organizationId,
      ...TRANSFER_CORRELATION,
    });
    const calls: string[] = [];
    const firstAttemptAt = Date.now();
    const snapshot = await createAndRetrieveStripeTransfer(
      {
        create: (async () => {
          calls.push("create");
          return {
            id: "tr_crash",
            amount: local.amount,
            amount_reversed: 0,
            currency: local.currency,
            destination: local.connectedAccountId,
            metadata: {
              publisherTransferId: local.transferId,
              correlationNonce: local.correlationNonce,
              correlationHmac: local.correlationHmac,
              platformAccountId: local.platformAccountId,
              metadataRepairVersion: "2",
              requestFingerprint: local.requestFingerprint,
            },
          } as Stripe.Transfer;
        }) as Stripe["transfers"]["create"],
        retrieve: (async () => {
          calls.push("retrieve");
          return {
            id: "tr_crash",
            amount: local.amount,
            amount_reversed: local.amount,
            reversed: true,
            currency: local.currency,
            destination: local.connectedAccountId,
            metadata: {
              publisherTransferId: local.transferId,
              correlationNonce: local.correlationNonce,
              correlationHmac: local.correlationHmac,
              platformAccountId: local.platformAccountId,
              metadataRepairVersion: "2",
              requestFingerprint: local.requestFingerprint,
            },
          } as Stripe.Transfer;
        }) as Stripe["transfers"]["retrieve"],
      },
      {
        _id: local.transferId,
        publisherOrganizationId: seed.organizationId,
        stripeConnectedAccountId: local.connectedAccountId,
        amount: local.amount,
        currency: local.currency,
        idempotencyKey: local.idempotencyKey,
        correlationNonce: local.correlationNonce,
        correlationHmac: local.correlationHmac,
        platformAccountId: local.platformAccountId,
        correlationState: local.correlationState,
        metadataRepairVersion: local.metadataRepairVersion,
        providerCreateMetadataShape: local.providerCreateMetadataShape,
        requestFingerprint: local.requestFingerprint,
      },
      {
        leaseToken: "lease-crash",
        firstAttemptAt,
        safeRetryUntil: firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS,
        requestFingerprint: local.requestFingerprint,
        nowMs: firstAttemptAt,
      },
    );
    expect(calls).toEqual(["create", "retrieve"]);
    expect(snapshot.amount_reversed).toBe(local.amount);

    const projection = {
      stripeTransferId: snapshot.id,
      publisherTransferId: snapshot.metadata.publisherTransferId,
      amount: snapshot.amount,
      amountReversed: snapshot.amount_reversed,
      currency: snapshot.currency,
      destination:
        typeof snapshot.destination === "string"
          ? snapshot.destination
          : snapshot.destination.id,
      platformAccountId: snapshot.metadata.platformAccountId,
      correlationNonce: snapshot.metadata.correlationNonce,
      correlationHmac: snapshot.metadata.correlationHmac,
      metadataRepairVersion: Number(snapshot.metadata.metadataRepairVersion),
      requestFingerprint: snapshot.metadata.requestFingerprint,
      failed: false,
      failureReason: undefined,
    } as const;
    await expect(
      t.mutation(internal.payouts.projectStripeTransfer, {
        ...projection,
        stripeTransferId: "tr_spoof",
        destination: "acct_attacker",
      }),
    ).rejects.toThrow("does not match allocation");
    await t.mutation(internal.payouts.projectStripeTransfer, projection);
    await t.mutation(internal.payouts.projectStripeTransfer, projection);
    const state = await t.run(async (ctx) => ({
      transfer: await ctx.db.get(local.transferId),
      balance: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seed.organizationId),
        )
        .unique(),
      ledger: await ctx.db.query("publisherSettlementEntries").collect(),
    }));
    expect(state.transfer).toMatchObject({
      stripeTransferId: "tr_crash",
      reversedAmount: local.amount,
      status: "reversed",
    });
    expect(state.balance).toMatchObject({
      availableAtoms: 1_045_000_000,
      allocatedAtoms: 0,
      paidAtoms: 0,
    });
    expect(state.ledger.map((entry) => entry.kind)).toEqual([
      "earning_release",
      "transfer_allocation",
      "transfer_succeeded",
      "transfer_reversal",
    ]);
  });

  it("repairs legacy provider metadata without changing original idempotent create", async () => {
    const t = convexTest(schema, modules);
    const transferId = await t.run(async (ctx) => {
      const publisherOrganizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_legacy_repair",
        name: "Legacy repair",
        slug: "legacy-repair",
      });
      const publisherBalanceId = await ctx.db.insert("publisherBalances", {
        publisherOrganizationId,
        availableAtoms: 0,
        allocatedAtoms: 500_000_000,
        paidAtoms: 0,
        pendingRiskAtoms: 0,
        reversedAtoms: 0,
        failedAtoms: 0,
        sequence: 1,
        migrationStatus: "verified",
        migrationWatermarkSequence: 1,
        updatedAt: 1,
      });
      const transferId = await ctx.db.insert("publisherTransfers", {
        publisherOrganizationId,
        stripeConnectedAccountId: "acct_legacy_destination",
        amount: 500,
        amountAtoms: 500_000_000,
        remainderAtoms: 0,
        currency: "usd",
        idempotencyKey: "publisher-transfer:legacy-original",
        reversedAmount: 0,
        correlationNonce: "c".repeat(64),
        platformAccountId: "acct_platformtest",
        correlationState: "provider_repair_required",
        metadataRepairVersion: 1,
        providerCreateMetadataShape: "publisher_only",
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      });
      const correlationHmac = await signTransferCorrelation(TRANSFER_SECRET, {
        publisherTransferId: transferId,
        nonce: "c".repeat(64),
        platformAccountId: "acct_platformtest",
        destination: "acct_legacy_destination",
        currency: "usd",
        amount: 500,
      });
      await ctx.db.patch(transferId, { correlationHmac });
      await ctx.db.insert("publisherSettlementEntries", {
        publisherBalanceId,
        publisherOrganizationId,
        kind: "transfer_allocation",
        availableDeltaAtoms: -500_000_000,
        allocatedDeltaAtoms: 500_000_000,
        paidDeltaAtoms: 0,
        refId: `publisher:transfer:${transferId}:allocated`,
        sequence: 1,
        transferId,
        createdAt: 1,
      });
      await ctx.db.insert("financialMigrationJobs", {
        migrationKey: FINANCE_MIGRATION_KEY,
        status: "failed",
        phase: "conservation",
        accumulatorA: 0,
        accumulatorB: 0,
        accumulatorC: 0,
        rowsRead: 0,
        rowsWritten: 0,
        chunks: 1,
        lastError: "provider repair required",
        createdAt: 1,
        updatedAt: 1,
      });
      return transferId;
    });
    const local = await t.mutation(
      internal.payouts.getLegacyPublisherTransferForRepair,
      { transferId },
    );

    let metadata: Record<string, string> = {
      publisherTransferId: local._id,
    };
    let creates = 0;
    let listCalls = 0;
    let updateOptions: Stripe.RequestOptions | undefined;
    const providerSnapshot = (): Stripe.Transfer =>
      ({
        id: "tr_legacy_repair",
        amount: local.amount,
        amount_reversed: 0,
        currency: local.currency,
        destination: local.stripeConnectedAccountId,
        metadata: { ...metadata },
      }) as Stripe.Transfer;
    const snapshot = await repairAndRetrieveStripeTransferMetadata(
      {
        create: (async () => {
          creates += 1;
          throw new Error("legacy repair must not create");
        }) as Stripe["transfers"]["create"],
        list: (async () => {
          listCalls += 1;
          return { data: [providerSnapshot()], has_more: false };
        }) as Stripe["transfers"]["list"],
        retrieve: (async () =>
          providerSnapshot()) as Stripe["transfers"]["retrieve"],
        update: (async (_id, params, options) => {
          metadata = { ...metadata, ...params.metadata } as Record<
            string,
            string
          >;
          updateOptions = options;
          return providerSnapshot();
        }) as Stripe["transfers"]["update"],
      },
      local,
    );
    expect(creates).toBe(0);
    expect(listCalls).toBe(2);
    expect(updateOptions?.idempotencyKey).toBe(
      "publisher-transfer-metadata-repair:v2:tr_legacy_repair",
    );

    await t.mutation(
      internal.payouts.verifyLegacyStripeTransferMetadataRepair,
      {
        transferId: local._id,
        stripeTransferId: snapshot.id,
        amount: snapshot.amount,
        amountReversed: snapshot.amount_reversed,
        currency: snapshot.currency,
        destination:
          typeof snapshot.destination === "string"
            ? snapshot.destination
            : snapshot.destination.id,
        platformAccountId: snapshot.metadata.platformAccountId!,
        correlationNonce: snapshot.metadata.correlationNonce!,
        correlationHmac: snapshot.metadata.correlationHmac!,
        metadataRepairVersion: Number(snapshot.metadata.metadataRepairVersion),
        requestFingerprint: snapshot.metadata.requestFingerprint!,
      },
    );
    const repaired = await t.run(async (ctx) => ({
      transfer: await ctx.db.get(local._id),
      balance: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", local.publisherOrganizationId),
        )
        .unique(),
      ledger: await ctx.db
        .query("publisherSettlementEntries")
        .withIndex("by_transfer_sequence", (q) => q.eq("transferId", local._id))
        .collect(),
    }));
    expect(repaired.transfer).toMatchObject({
      stripeTransferId: "tr_legacy_repair",
      status: "succeeded",
      correlationState: "provider_verified",
      providerMetadataVerifiedAt: expect.any(Number),
    });
    expect(repaired.balance).toMatchObject({
      availableAtoms: 0,
      allocatedAtoms: 0,
      paidAtoms: 500_000_000,
      sequence: 2,
      migrationWatermarkSequence: 2,
    });
    expect(repaired.ledger.map((entry) => entry.kind)).toEqual([
      "transfer_allocation",
      "transfer_succeeded",
    ]);
  });

  it("replays pre-version correlated transfer metadata with its exact original shape", async () => {
    const t = convexTest(schema, modules);
    const transferId = await t.run(async (ctx) => {
      const publisherOrganizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_correlated_v0_repair",
        name: "Correlated v0 repair",
        slug: "correlated-v0-repair",
      });
      const transferId = await ctx.db.insert("publisherTransfers", {
        publisherOrganizationId,
        stripeConnectedAccountId: "acct_correlated_v0",
        amount: 700,
        amountAtoms: 700_000_000,
        remainderAtoms: 0,
        currency: "usd",
        idempotencyKey: "publisher-transfer:correlated-v0-original",
        reversedAmount: 0,
        correlationNonce: "d".repeat(64),
        platformAccountId: "acct_platformtest",
        correlationState: "provider_repair_required",
        metadataRepairVersion: 1,
        providerCreateMetadataShape: "correlated_v0",
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      });
      const correlationHmac = await signTransferCorrelation(TRANSFER_SECRET, {
        publisherTransferId: transferId,
        nonce: "d".repeat(64),
        platformAccountId: "acct_platformtest",
        destination: "acct_correlated_v0",
        currency: "usd",
        amount: 700,
      });
      await ctx.db.patch(transferId, { correlationHmac });
      await ctx.db.insert("financialMigrationJobs", {
        migrationKey: FINANCE_MIGRATION_KEY,
        status: "failed",
        phase: "transfers",
        accumulatorA: 0,
        accumulatorB: 0,
        accumulatorC: 0,
        rowsRead: 0,
        rowsWritten: 0,
        chunks: 1,
        lastError: "provider repair required",
        createdAt: 1,
        updatedAt: 1,
      });
      return transferId;
    });
    const local = await t.mutation(
      internal.payouts.getLegacyPublisherTransferForRepair,
      { transferId },
    );
    const originalMetadata = {
      publisherTransferId: String(local._id),
      correlationNonce: local.correlationNonce!,
      correlationHmac: local.correlationHmac!,
      platformAccountId: local.platformAccountId!,
    };
    let providerMetadata: Record<string, string> = { ...originalMetadata };
    let creates = 0;
    let listCalls = 0;
    const snapshot = (): Stripe.Transfer =>
      ({
        id: "tr_correlated_v0",
        amount: local.amount,
        amount_reversed: 0,
        currency: local.currency,
        destination: local.stripeConnectedAccountId,
        metadata: { ...providerMetadata },
      }) as Stripe.Transfer;
    await repairAndRetrieveStripeTransferMetadata(
      {
        create: (async () => {
          creates += 1;
          throw new Error("legacy repair must not create");
        }) as Stripe["transfers"]["create"],
        list: (async () => {
          listCalls += 1;
          return { data: [snapshot()], has_more: false };
        }) as Stripe["transfers"]["list"],
        retrieve: (async () => snapshot()) as Stripe["transfers"]["retrieve"],
        update: (async (_id, params) => {
          providerMetadata = {
            ...providerMetadata,
            ...params.metadata,
          } as Record<string, string>;
          return snapshot();
        }) as Stripe["transfers"]["update"],
      },
      local,
    );
    expect(creates).toBe(0);
    expect(listCalls).toBe(2);
    expect(providerMetadata).toEqual({
      ...originalMetadata,
      metadataRepairVersion: "2",
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("reconciles response loss across 1001 paginated rows and blocks pruned blind retries", async () => {
    const transferId = "transfer_provider_property" as Id<"publisherTransfers">;
    const publisherOrganizationId =
      "publisher_provider_property" as Id<"organizations">;
    const correlationNonce = "e".repeat(64);
    const correlationHmac = await signTransferCorrelation(TRANSFER_SECRET, {
      publisherTransferId: transferId,
      nonce: correlationNonce,
      platformAccountId: "acct_platformtest",
      destination: "acct_provider_property",
      currency: "usd",
      amount: 1_234,
    });
    const immutable = {
      publisherTransferId: transferId,
      publisherOrganizationId,
      destination: "acct_provider_property",
      amount: 1_234,
      currency: "usd",
      idempotencyKey: "publisher-transfer:provider-property",
      correlationNonce,
      correlationHmac,
      platformAccountId: "acct_platformtest",
    };
    const requestFingerprint = await transferRequestFingerprint(immutable);
    const local = {
      _id: transferId,
      _creationTime: 1,
      publisherOrganizationId,
      stripeConnectedAccountId: immutable.destination,
      amount: immutable.amount,
      amountAtoms: 1_234_000_000,
      remainderAtoms: 0,
      currency: immutable.currency,
      idempotencyKey: immutable.idempotencyKey,
      reversedAmount: 0,
      correlationNonce,
      correlationHmac,
      platformAccountId: immutable.platformAccountId,
      correlationState: "local_prepared",
      metadataRepairVersion: 2,
      providerCreateMetadataShape: "correlated_v2",
      requestFingerprint,
      status: "pending",
      attemptedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } as Doc<"publisherTransfers">;
    const exactMetadata = {
      publisherTransferId: transferId,
      correlationNonce,
      correlationHmac,
      platformAccountId: immutable.platformAccountId,
      metadataRepairVersion: "2",
      requestFingerprint,
    };
    const transferSnapshot = (
      id: string,
      metadata: Record<string, string> = {},
      amount = local.amount,
    ) =>
      ({
        id,
        amount,
        amount_reversed: 0,
        currency: local.currency,
        destination: local.stripeConnectedAccountId,
        metadata,
      }) as Stripe.Transfer;
    const distractors = Array.from({ length: 1_000 }, (_, index) =>
      transferSnapshot(`tr_noise_${String(index).padStart(4, "0")}`, {
        publisherTransferId: `other_${index}`,
      }),
    );
    const exact = transferSnapshot("tr_exact_1001", exactMetadata);

    let visible = [...distractors, exact];
    let listCalls = 0;
    const provider = {
      list: (async (params: Stripe.TransferListParams) => {
        listCalls += 1;
        const start =
          params.starting_after === undefined
            ? 0
            : visible.findIndex((row) => row.id === params.starting_after) + 1;
        const limit = params.limit ?? 10;
        const data = visible.slice(start, start + limit);
        return { data, has_more: start + data.length < visible.length };
      }) as Stripe["transfers"]["list"],
      retrieve: (async (id: string) => {
        const row = visible.find((candidate) => candidate.id === id);
        if (row === undefined) throw new Error("provider row missing");
        return row;
      }) as Stripe["transfers"]["retrieve"],
    };
    const reconciled = await reconcileStripeTransferProvider(provider, local, {
      firstAttemptAt: local.attemptedAt!,
      observedThrough: local.attemptedAt! + 1_000,
    });
    expect(reconciled).toMatchObject({
      kind: "exact",
      snapshot: { id: "tr_exact_1001" },
      pages: 22,
    });
    expect(listCalls).toBe(22);

    visible = [
      ...visible,
      transferSnapshot("tr_exact_duplicate", exactMetadata),
    ];
    expect(
      await reconcileStripeTransferProvider(provider, local, {
        firstAttemptAt: local.attemptedAt!,
        observedThrough: local.attemptedAt! + 1_000,
      }),
    ).toMatchObject({
      kind: "multiple",
      exactIds: ["tr_exact_1001", "tr_exact_duplicate"],
    });
    visible = [
      ...distractors,
      transferSnapshot("tr_conflict", exactMetadata, local.amount + 1),
    ];
    expect(
      await reconcileStripeTransferProvider(provider, local, {
        firstAttemptAt: local.attemptedAt!,
        observedThrough: local.attemptedAt! + 1_000,
      }),
    ).toMatchObject({ kind: "conflict", conflictIds: ["tr_conflict"] });

    let consistencyPass = 0;
    const inconsistent = await reconcileStripeTransferProvider(
      {
        list: (async (params: Stripe.TransferListParams) => {
          if (params.starting_after === undefined) consistencyPass += 1;
          return {
            data: consistencyPass === 1 ? [exact] : [],
            has_more: false,
          };
        }) as Stripe["transfers"]["list"],
        retrieve: provider.retrieve,
      },
      local,
      {
        firstAttemptAt: local.attemptedAt!,
        observedThrough: local.attemptedAt! + 1_000,
      },
    );
    expect(inconsistent).toMatchObject({ kind: "inconsistent" });

    let truncatedPage = 0;
    expect(
      await reconcileStripeTransferProvider(
        {
          list: (async () => {
            const page = truncatedPage++;
            return {
              data: Array.from({ length: 100 }, (_, index) =>
                transferSnapshot(`tr_truncated_${page}_${index}`),
              ),
              has_more: true,
            };
          }) as Stripe["transfers"]["list"],
          retrieve: provider.retrieve,
        },
        local,
        {
          firstAttemptAt: local.attemptedAt!,
          observedThrough: local.attemptedAt! + 1_000,
        },
      ),
    ).toMatchObject({ kind: "truncated", pages: 40 });

    visible = distractors;
    expect(
      await reconcileStripeTransferProvider(provider, local, {
        firstAttemptAt: local.attemptedAt!,
        observedThrough: local.attemptedAt! + 1_000,
      }),
    ).toMatchObject({ kind: "none" });
    let creates = 0;
    await expect(
      createAndRetrieveStripeTransfer(
        {
          create: (async () => {
            creates += 1;
            return exact;
          }) as Stripe["transfers"]["create"],
          retrieve: provider.retrieve,
        },
        local,
        {
          leaseToken: "expired-provider-lease",
          firstAttemptAt: local.attemptedAt!,
          safeRetryUntil: local.attemptedAt! + STRIPE_TRANSFER_SAFE_RETRY_MS,
          requestFingerprint,
          nowMs: local.attemptedAt! + STRIPE_TRANSFER_SAFE_RETRY_MS,
        },
      ),
    ).rejects.toThrow("Active safe-window transfer dispatch lease required");
    expect(creates).toBe(0);

    const firstAttemptAt = Date.now();
    await expect(
      createAndRetrieveStripeTransfer(
        {
          create: (async () => {
            creates += 1;
            visible = [...distractors, exact];
            return exact;
          }) as Stripe["transfers"]["create"],
          retrieve: (async () => {
            throw new Error("response lost after provider accepted transfer");
          }) as Stripe["transfers"]["retrieve"],
        },
        local,
        {
          leaseToken: "response-loss-lease",
          firstAttemptAt,
          safeRetryUntil: firstAttemptAt + STRIPE_TRANSFER_SAFE_RETRY_MS,
          requestFingerprint,
          nowMs: firstAttemptAt,
        },
      ),
    ).rejects.toThrow("response lost");
    expect(creates).toBe(1);
    expect(
      await reconcileStripeTransferProvider(provider, local, {
        firstAttemptAt,
        observedThrough: firstAttemptAt + 1_000,
      }),
    ).toMatchObject({ kind: "exact", snapshot: { id: "tr_exact_1001" } });
    expect(creates).toBe(1);
  });

  it("fails closed instead of zero-lying for a staged legacy balance", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_totals",
        name: "Totals",
        slug: "totals",
      });
      await ctx.db.insert("publisherBalances", {
        publisherOrganizationId: organizationId,
        availableAtoms: 0,
        allocatedAtoms: 0,
        paidAtoms: 0,
        sequence: 0,
        updatedAt: 1,
      });
    });
    await expect(
      t
        .withIdentity({
          subject: "totals_user",
          org_id: "org_totals",
          org_role: "org:member",
        } as { subject: string; org_id: string; org_role: string })
        .query(api.payouts.getPayoutState, {}),
    ).rejects.toThrow("Publisher finance migration is not verified");
  });
});
