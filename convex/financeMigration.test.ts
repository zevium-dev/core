/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { transferRequestFingerprint } from "./payouts";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("staged finance migration", () => {
  const priorAdmin = process.env.ADMIN_USER_IDS;
  const priorSecret = process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
  const priorPlatform = process.env.STRIPE_PLATFORM_ACCOUNT_ID;

  beforeEach(() => {
    process.env.ADMIN_USER_IDS = "migration_admin";
    process.env.STRIPE_TRANSFER_CORRELATION_SECRET =
      "migration-transfer-secret-32-bytes";
    process.env.STRIPE_PLATFORM_ACCOUNT_ID = "acct_platformmigration";
  });

  afterEach(() => {
    if (priorAdmin === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdmin;
    if (priorSecret === undefined) {
      delete process.env.STRIPE_TRANSFER_CORRELATION_SECRET;
    } else {
      process.env.STRIPE_TRANSFER_CORRELATION_SECRET = priorSecret;
    }
    if (priorPlatform === undefined)
      delete process.env.STRIPE_PLATFORM_ACCOUNT_ID;
    else process.env.STRIPE_PLATFORM_ACCOUNT_ID = priorPlatform;
  });

  it("refuses to fence a half-processed Stripe workflow", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("paymentEvents", {
        stripeEventId: "evt_migration_inflight",
        stripeAccount: "acct_platformmigration",
        eventType: "checkout.session.completed",
        objectId: "cs_migration_inflight",
        status: "processing",
        attempts: 1,
        deliveries: 1,
        receivedAt: 1,
        leaseExpiresAt: Date.now() + 60_000,
      });
    });
    const admin = t.withIdentity({ subject: "migration_admin" } as {
      subject: string;
    });
    await expect(
      admin.mutation(api.financeMigration.start, {}),
    ).rejects.toThrow("must be drained before finance migration");
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("financialMigrationJobs").collect(),
      ),
    ).toEqual([]);
  });

  it("verifies an empty legacy deployment without manufacturing finance rows", async () => {
    const t = convexTest(schema, modules);
    const admin = t.withIdentity({ subject: "migration_admin" } as {
      subject: string;
    });
    const jobId = await admin.mutation(api.financeMigration.start, {});
    for (let index = 0; index < 100; index += 1) {
      const status = await admin.query(api.financeMigration.status, {});
      if (status?.status === "verified") break;
      if (status?.status === "failed") {
        throw new Error(status.lastError ?? "empty migration failed");
      }
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    const result = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      wallets: await ctx.db.query("walletFundingStates").collect(),
      lots: await ctx.db.query("walletFundingLots").collect(),
      publishers: await ctx.db.query("publisherBalances").collect(),
      exposures: await ctx.db.query("paymentExposures").collect(),
      audits: await ctx.db
        .query("financialMigrationAudits")
        .withIndex("by_job_created", (q) => q.eq("migrationJobId", jobId))
        .collect(),
    }));
    expect(result.job).toMatchObject({
      status: "verified",
      phase: "complete",
      rowsWritten: 0,
    });
    expect(result.wallets).toHaveLength(0);
    expect(result.lots).toHaveLength(0);
    expect(result.publishers).toHaveLength(0);
    expect(result.exposures).toHaveLength(0);
    expect(result.audits.at(-1)).toMatchObject({
      phase: "conservation",
      result: "verified",
    });
  });

  it("keeps scope deletion fenced for the complete global snapshot", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.organizations.upsertFromClerk, {
      clerkOrgId: "org_delete_race",
      name: "Delete race",
      slug: "delete-race",
    });
    const admin = t.withIdentity({ subject: "migration_admin" } as {
      subject: string;
    });
    const jobId = await admin.mutation(api.financeMigration.start, {});
    await expect(
      t.mutation(internal.organizations.deleteFromClerk, {
        clerkOrgId: "org_delete_race",
      }),
    ).rejects.toThrow("Finance migration is fenced");
    await expect(
      t.mutation(internal.billing.receiveStripeEvent, {
        stripeEventId: "evt_post_fence",
        stripeAccount: "acct_platformmigration",
        eventType: "checkout.session.completed",
        objectId: "cs_post_fence",
      }),
    ).rejects.toThrow("Finance migration is fenced");
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("paymentEvents")
          .withIndex("by_stripe_event", (q) =>
            q.eq("stripeEventId", "evt_post_fence"),
          )
          .unique(),
      ),
    ).toBeNull();
    for (let chunk = 0; chunk < 250; chunk += 1) {
      const status = await admin.query(api.financeMigration.status, {});
      if (status?.status === "verified") break;
      if (status?.status === "failed")
        throw new Error(status.lastError ?? "delete-race migration failed");
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    expect(await admin.query(api.financeMigration.status, {})).toMatchObject({
      status: "verified",
      snapshotFenceToken: expect.any(String),
      finalWatermark: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("archives scope terminally while referenced money rows survive", async () => {
    for (const child of ["checkout", "connected-payout"] as const) {
      const t = convexTest(schema, modules);
      const organizationId = await t.mutation(
        internal.organizations.upsertFromClerk,
        {
          clerkOrgId: `org_delete_${child}`,
          name: "Delete guard",
          slug: `delete-${child}`,
        },
      );
      await t.run(async (ctx) => {
        if (child === "checkout") {
          await ctx.db.insert("checkoutIntents", {
            organizationId,
            packId: "pack_10",
            stripePriceId: "price_delete_guard",
            amount: 1_000,
            currency: "usd",
            credits: 100_000,
            status: "created",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
          });
        } else {
          await ctx.db.insert("organizationPayments", {
            organizationId,
            stripeConnectedAccountId: "acct_delete_guard",
            detailsSubmitted: true,
            chargesEnabled: true,
            payoutsEnabled: true,
            requirements: [],
            updatedAt: 1,
          });
          await ctx.db.insert("connectedPayouts", {
            stripeConnectedAccountId: "acct_delete_guard",
            stripePayoutId: "po_delete_guard",
            amount: 100,
            currency: "usd",
            status: "paid",
            updatedAt: 1,
          });
        }
      });

      // Archive flow never deletes: org row + money history retained,
      // tombstone marks the terminal state.
      await t.mutation(internal.organizations.deleteFromClerk, {
        clerkOrgId: `org_delete_${child}`,
      });
      const archived = await t.run(async (ctx) => ({
        org: await ctx.db.get(organizationId),
        tombstone: await ctx.db
          .query("organizationTombstones")
          .withIndex("by_clerk_org", (q) =>
            q.eq("clerkOrgId", `org_delete_${child}`),
          )
          .unique(),
      }));
      expect(archived.org?.archivedAt).not.toBeUndefined();
      expect(archived.tombstone).not.toBeNull();
    }
  });

  it("independently rejects orphan children and cross-scope funding state", async () => {
    for (const fault of ["orphan-entry", "cross-scope-state"] as const) {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        const firstOrganizationId = await ctx.db.insert("organizations", {
          clerkOrgId: `org_${fault}_first`,
          name: "First",
          slug: `${fault}-first`,
        });
        const secondOrganizationId = await ctx.db.insert("organizations", {
          clerkOrgId: `org_${fault}_second`,
          name: "Second",
          slug: `${fault}-second`,
        });
        const walletId = await ctx.db.insert("wallets", {
          organizationId: firstOrganizationId,
          balance: 0,
          sequence: 0,
        });
        if (fault === "orphan-entry") {
          await ctx.db.insert("walletEntries", {
            walletId,
            kind: "admin_adjustment",
            amount: 1,
            refId: "admin:orphan-entry",
            sequence: 1,
            createdAt: 1,
          });
          await ctx.db.delete(walletId);
        } else {
          await ctx.db.insert("walletFundingStates", {
            walletId,
            organizationId: secondOrganizationId,
            nonrefundableAvailableCredits: 0,
            refundableAvailableCredits: 0,
            allocatedCredits: 0,
            reversedCredits: 0,
            sequence: 0,
            migrationStatus: "verified",
            migrationWatermarkSequence: 0,
            updatedAt: 1,
          });
        }
      });
      const admin = t.withIdentity({ subject: "migration_admin" } as {
        subject: string;
      });
      const jobId = await admin.mutation(api.financeMigration.start, {});
      for (let chunk = 0; chunk < 250; chunk += 1) {
        const status = await admin.query(api.financeMigration.status, {});
        if (status?.status === "failed") break;
        await t.mutation(internal.financeMigration.runChunk, { jobId });
      }
      const status = await admin.query(api.financeMigration.status, {});
      expect(status).toMatchObject({
        status: "failed",
        phase: "conservation",
      });
      expect(status?.finalWatermark).toBeUndefined();
      expect(status?.lastError).toMatch(
        fault === "orphan-entry" ? /orphaned finance scope/ : /cross-scope/,
      );
    }
  });

  it("resumes legacy production-shaped rows and verifies conservation", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const consumerId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_migration_consumer",
        name: "Migration consumer",
        slug: "migration-consumer",
      });
      const publisherId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_migration_publisher",
        name: "Migration publisher",
        slug: "migration-publisher",
      });
      const projectId = await ctx.db.insert("projects", {
        organizationId: publisherId,
        name: "Migration API",
        slug: "migration-api",
        status: "published",
        visibility: "public",
        tags: [],
      });
      const specVersionId = await ctx.db.insert("specVersions", {
        projectId,
        version: "legacy-v1",
        spec: "{}",
        publishedAt: 1,
      });
      const walletId = await ctx.db.insert("wallets", {
        organizationId: consumerId,
        balance: 300,
        sequence: 5,
      });
      const intentId = await ctx.db.insert("checkoutIntents", {
        organizationId: consumerId,
        packId: "pack_10",
        stripePriceId: "price_legacy",
        amount: 1_000,
        currency: "usd",
        credits: 1_000,
        stripeCheckoutSessionId: "cs_legacy",
        stripePaymentIntentId: "pi_legacy",
        status: "complete",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      });
      const paymentId = await ctx.db.insert("payments", {
        organizationId: consumerId,
        checkoutIntentId: intentId,
        stripeCheckoutSessionId: "cs_legacy",
        stripePaymentIntentId: "pi_legacy",
        stripeChargeId: "ch_legacy",
        amount: 1_000,
        currency: "usd",
        grantedCredits: 1_000,
        // Legacy row predates refund aggregates; provider facts below repair it.
        reversedCredits: 200,
        status: "partially_refunded",
        createdAt: 1,
        updatedAt: 5,
      });
      const usageId = await ctx.db.insert("usageEvents", {
        organizationId: consumerId,
        publisherOrganizationId: publisherId,
        projectId,
        specVersionId,
        specVersion: "legacy-v1",
        operationId: "GET /legacy",
        endpoint: "/legacy",
        method: "GET",
        listedCostCredits: 600,
        pricingDecision: "listed_price",
        credits: 600,
        status: 200,
        latencyMs: 5,
        keyId: "key_legacy",
        keyFamilyId: "key_family_legacy",
        budgetPeriod: "2026-08",
        budgetUsedBefore: 0,
        budgetReservedBefore: 0,
        budgetReservationCredits: 600,
        at: 3,
        reservationId: "legacy",
        settlementIdentityVersion: 2,
        settleRefId: "settle:legacy",
      });
      const entries = [
        {
          kind: "payment_grant" as const,
          amount: 1_000,
          refId: "stripe:payment_intent:pi_legacy",
          paymentId,
          createdAt: 1,
        },
        {
          kind: "admin_adjustment" as const,
          amount: 100,
          refId: "promo:legacy",
          createdAt: 2,
        },
        {
          kind: "usage_settlement" as const,
          amount: -600,
          refId: "settle:legacy",
          usageEventId: usageId,
          createdAt: 3,
        },
        {
          kind: "admin_adjustment" as const,
          amount: -100,
          refId: "admin:legacy:debit",
          createdAt: 4,
        },
        {
          kind: "refund_reversal" as const,
          amount: -100,
          refId: "stripe:refund:re_legacy:wallet:reverse:100",
          paymentId,
          createdAt: 5,
        },
      ];
      for (const [index, entry] of entries.entries()) {
        await ctx.db.insert("walletEntries", {
          walletId,
          sequence: index + 1,
          ...entry,
        });
      }

      const earningId = await ctx.db.insert("publisherEarnings", {
        publisherOrganizationId: publisherId,
        consumerOrganizationId: consumerId,
        projectId,
        specVersionId,
        usageSettlementRefId: "settle:legacy",
        grossCredits: 600,
        platformFeeAtoms: 300_000,
        publisherNetAtoms: 5_700_000,
        platformFeeCredits: 30,
        netCredits: 570,
        clawedBackGrossCredits: 100,
        clawedBackAtoms: 950_000,
        releasedAtoms: 4_750_000,
        availableAt: 1,
        status: "transferred",
        createdAt: 3,
        updatedAt: 5,
      });
      const balanceId = await ctx.db.insert("publisherBalances", {
        publisherOrganizationId: publisherId,
        availableAtoms: 1_750_000,
        allocatedAtoms: 0,
        paidAtoms: 3_000_000,
        sequence: 5,
        updatedAt: 5,
      });
      await ctx.db.insert("publisherSettlementEntries", {
        publisherBalanceId: balanceId,
        publisherOrganizationId: publisherId,
        kind: "earning_release",
        availableDeltaAtoms: 5_700_000,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
        refId: `publisher:earning:${earningId}:release`,
        sequence: 1,
        earningId,
        createdAt: 3,
      });
      const transferId = await ctx.db.insert("publisherTransfers", {
        publisherOrganizationId: publisherId,
        stripeConnectedAccountId: "acct_legacy_publisher",
        amount: 5,
        amountAtoms: 5_000_000,
        remainderAtoms: 700_000,
        currency: "usd",
        idempotencyKey: "publisher-transfer:legacy",
        stripeTransferId: "tr_legacy",
        status: "succeeded",
        createdAt: 4,
        updatedAt: 5,
      });
      await ctx.db.patch(earningId, { transferId });
      await ctx.db.insert("publisherClawbacks", {
        paymentId,
        consumerOrganizationId: consumerId,
        publisherOrganizationId: publisherId,
        earningId,
        sourceKind: "refund",
        sourceRef: "stripe:refund:re_legacy",
        grossCredits: 100,
        amountAtoms: 950_000,
        createdAt: 5,
        updatedAt: 5,
      });
      await ctx.db.insert("publisherSettlementEntries", {
        publisherBalanceId: balanceId,
        publisherOrganizationId: publisherId,
        kind: "refund_clawback",
        availableDeltaAtoms: -950_000,
        allocatedDeltaAtoms: 0,
        paidDeltaAtoms: 0,
        refId: "stripe:refund:re_legacy:clawback:legacy",
        sequence: 4,
        earningId,
        paymentId,
        createdAt: 5,
      });
      for (const entry of [
        {
          kind: "transfer_allocation" as const,
          availableDeltaAtoms: -5_000_000,
          allocatedDeltaAtoms: 5_000_000,
          paidDeltaAtoms: 0,
          refId: "publisher:transfer:legacy:allocated",
          sequence: 2,
          createdAt: 4,
        },
        {
          kind: "transfer_succeeded" as const,
          availableDeltaAtoms: 0,
          allocatedDeltaAtoms: -5_000_000,
          paidDeltaAtoms: 5_000_000,
          refId: "publisher:transfer:legacy:succeeded",
          sequence: 3,
          createdAt: 4,
        },
        {
          kind: "transfer_reversal" as const,
          availableDeltaAtoms: 2_000_000,
          allocatedDeltaAtoms: 0,
          paidDeltaAtoms: -2_000_000,
          refId: "publisher:transfer:legacy:reversed:2",
          sequence: 5,
          createdAt: 5,
        },
      ]) {
        await ctx.db.insert("publisherSettlementEntries", {
          publisherBalanceId: balanceId,
          publisherOrganizationId: publisherId,
          transferId,
          ...entry,
        });
      }
      return { walletId, paymentId, publisherId, transferId };
    });

    const admin = t.withIdentity({ subject: "migration_admin" } as {
      subject: string;
    });
    const jobId = await admin.mutation(api.financeMigration.start, {});
    for (let index = 0; index < 3; index += 1) {
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    expect(await admin.mutation(api.financeMigration.start, {})).toBe(jobId);
    await expect(
      t.mutation(internal.wallets.applyAdminAdjustment, {
        organizationId: seeded.publisherId,
        amount: 1,
        refId: "admin:migration:concurrent",
      }),
    ).rejects.toThrow("Finance migration is fenced");

    for (let index = 0; index < 500; index += 1) {
      const status = await admin.query(api.financeMigration.status, {});
      if (status?.status === "failed") break;
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    const unknownRefund = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      payment: await ctx.db.get(seeded.paymentId),
      exposures: await ctx.db
        .query("paymentExposures")
        .withIndex("by_payment_created", (q) =>
          q.eq("paymentId", seeded.paymentId),
        )
        .collect(),
    }));
    expect(unknownRefund.job).toMatchObject({
      status: "failed",
      phase: "conservation",
    });
    expect(unknownRefund.payment).toMatchObject({
      financeMigrationStatus: "provider_reconciliation_required",
    });
    expect(unknownRefund.exposures).toEqual([]);
    await admin.mutation(api.financeMigration.recordLegacyRefundFacts, {
      paymentId: seeded.paymentId,
      refunds: [
        {
          stripeRefundId: "re_legacy",
          amount: 200,
          status: "succeeded",
          createdAt: 5,
        },
      ],
    });
    for (let index = 0; index < 1_000; index += 1) {
      const status = await admin.query(api.financeMigration.status, {});
      if (status?.status === "failed") break;
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    const repair = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const transfer = await ctx.db.get(seeded.transferId);
      return { job, transfer };
    });
    expect(repair.job).toMatchObject({
      status: "failed",
      phase: "conservation",
    });
    expect(repair.transfer).toMatchObject({
      correlationState: "provider_repair_required",
      providerCreateMetadataShape: "publisher_only",
      reversedAmount: 2,
    });
    expect(repair.transfer?.providerMetadataVerifiedAt).toBeUndefined();
    if (
      repair.transfer?.correlationNonce === undefined ||
      repair.transfer.correlationHmac === undefined ||
      repair.transfer.platformAccountId === undefined
    ) {
      throw new Error("migration correlation repair fields missing");
    }
    const requestFingerprint = await transferRequestFingerprint({
      publisherTransferId: seeded.transferId,
      publisherOrganizationId: seeded.publisherId,
      destination: "acct_legacy_publisher",
      amount: 5,
      currency: "usd",
      idempotencyKey: "publisher-transfer:legacy",
      correlationNonce: repair.transfer.correlationNonce,
      correlationHmac: repair.transfer.correlationHmac,
      platformAccountId: repair.transfer.platformAccountId,
    });
    await t.mutation(
      internal.payouts.verifyLegacyStripeTransferMetadataRepair,
      {
        transferId: seeded.transferId,
        stripeTransferId: "tr_legacy",
        amount: 5,
        amountReversed: 2,
        currency: "usd",
        destination: "acct_legacy_publisher",
        platformAccountId: repair.transfer.platformAccountId,
        correlationNonce: repair.transfer.correlationNonce,
        correlationHmac: repair.transfer.correlationHmac,
        metadataRepairVersion: 2,
        requestFingerprint,
      },
    );
    await admin.mutation(api.financeMigration.start, {});
    for (let index = 0; index < 500; index += 1) {
      const status = await admin.query(api.financeMigration.status, {});
      if (status?.status === "verified") break;
      if (status?.status === "failed") {
        throw new Error(status.lastError ?? "migration failed after repair");
      }
      await t.mutation(internal.financeMigration.runChunk, { jobId });
    }
    await t.mutation(internal.billing.applyRefundProjection, {
      stripeRefundId: "re_legacy",
      stripeChargeId: "ch_legacy",
      refundAmount: 200,
      totalRefundedAmount: 200,
      status: "succeeded",
    });

    const result = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      wallet: await ctx.db.get(seeded.walletId),
      payment: await ctx.db.get(seeded.paymentId),
      fundingState: await ctx.db
        .query("walletFundingStates")
        .withIndex("by_wallet", (q) => q.eq("walletId", seeded.walletId))
        .unique(),
      lots: await ctx.db.query("walletFundingLots").collect(),
      entries: await ctx.db
        .query("walletEntries")
        .withIndex("by_wallet_sequence", (q) =>
          q.eq("walletId", seeded.walletId),
        )
        .collect(),
      components: await ctx.db.query("walletFundingLotComponents").collect(),
      allocations: await ctx.db.query("walletFundingAllocations").collect(),
      reversals: await ctx.db.query("walletFundingReversals").collect(),
      clawbacks: await ctx.db.query("publisherClawbacks").collect(),
      exposures: await ctx.db.query("paymentExposures").collect(),
      publisher: await ctx.db
        .query("publisherBalances")
        .withIndex("by_publisher", (q) =>
          q.eq("publisherOrganizationId", seeded.publisherId),
        )
        .unique(),
      transfer: await ctx.db.get(seeded.transferId),
      audits: await ctx.db
        .query("financialMigrationAudits")
        .withIndex("by_job_created", (q) => q.eq("migrationJobId", jobId))
        .collect(),
    }));
    expect(result.job).toMatchObject({
      status: "verified",
      phase: "complete",
      snapshotFenceToken: expect.any(String),
      finalWatermark: expect.stringMatching(/^[0-9a-f]{64}$/),
      finalWatermarkAt: expect.any(Number),
    });
    expect(result.wallet).toMatchObject({ balance: 300, debtCredits: 0 });
    expect(result.payment).toMatchObject({
      walletReversedCredits: 100,
      publisherClawbackTargetCredits: 100,
    });
    expect(result.fundingState).toMatchObject({
      nonrefundableAvailableCredits: 0,
      refundableAvailableCredits: 300,
      allocatedCredits: 700,
      reversedCredits: 100,
    });
    expect(result.lots).toHaveLength(2);
    expect(result.allocations).toHaveLength(3);
    expect(result.reversals).toHaveLength(1);
    expect(result.clawbacks).toEqual([
      expect.objectContaining({
        allocationId: expect.any(String),
        restoredGrossCredits: 0,
        restoredAtoms: 0,
        state: "active",
      }),
    ]);
    expect(result.exposures).toEqual([
      expect.objectContaining({
        sourceRef: "stripe:refund:re_legacy",
        walletCredits: 100,
        publisherCredits: 100,
        appliedPublisherCredits: 100,
        migrationBackfilled: false,
      }),
    ]);
    expect(result.publisher).toMatchObject({
      availableAtoms: 1_750_000,
      allocatedAtoms: 0,
      paidAtoms: 3_000_000,
      pendingRiskAtoms: 0,
      reversedAtoms: 950_000,
      failedAtoms: 0,
    });
    expect(result.transfer).toMatchObject({
      reversedAmount: 2,
      platformAccountId: "acct_platformmigration",
      correlationNonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      correlationHmac: expect.stringMatching(/^[0-9a-f]{64}$/),
      correlationState: "provider_verified",
      metadataRepairVersion: 2,
      requestFingerprint,
      providerCreateMetadataShape: "publisher_only",
      providerMetadataVerifiedAt: expect.any(Number),
    });
    const ledgerBalance = result.entries.reduce(
      (sum, entry) => sum + entry.amount,
      0,
    );
    const rootGranted = result.lots
      .filter((lot) => lot.sourceKind !== "compaction")
      .reduce((sum, lot) => sum + lot.grantedCredits, 0);
    const lotAvailable = result.lots.reduce(
      (sum, lot) => sum + lot.availableCredits,
      0,
    );
    const lotAllocated = result.lots.reduce(
      (sum, lot) => sum + lot.allocatedCredits,
      0,
    );
    const lotReversed = result.lots.reduce(
      (sum, lot) => sum + lot.reversedCredits,
      0,
    );
    expect(result.components).toHaveLength(0);
    expect({
      ledgerBalance,
      rootGranted,
      lotAvailable,
      lotAllocated,
      lotReversed,
    }).toEqual({
      ledgerBalance: 300,
      rootGranted: 1_100,
      lotAvailable: 300,
      lotAllocated: 700,
      lotReversed: 100,
    });
    expect(result.audits.some((audit) => audit.result === "verified")).toBe(
      true,
    );
  });
});
