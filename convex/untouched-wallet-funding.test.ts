/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "./_generated/api";
import { FINANCE_MIGRATION_KEY } from "./lib/financeMigrationGate";
import { getOrCreateWallet } from "./wallets";
import schema from "./schema";

async function seed(balance = 0, sequence = 0, debtCredits = 0) {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const ids = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_untouched",
      name: "Untouched",
      slug: "untouched",
    });
    const walletId = await ctx.db.insert("wallets", {
      organizationId,
      balance,
      sequence,
      debtCredits,
    });
    return { organizationId, walletId };
  });
  const member = t.withIdentity({
    subject: "user_untouched",
    org_id: "org_untouched",
    org_slug: "untouched",
    org_role: "org:admin",
  });
  return { t, member, ...ids };
}

it("restores an untouched legacy wallet through organization mirroring, idempotently", async () => {
  const { t, member, walletId } = await seed();
  const before = await t.run((ctx) => ctx.db.get(walletId));
  await member.mutation(api.organizations.ensureOrganization, {
    clerkOrgId: "org_untouched",
  });
  await member.mutation(api.organizations.ensureOrganization, {
    clerkOrgId: "org_untouched",
  });
  expect(
    await member.query(api.wallets.getMyWallet, { orgSlug: "untouched" }),
  ).toEqual({ balance: 0, sequence: 0, entries: [] });
  expect(await t.run((ctx) => ctx.db.get(walletId))).toEqual(before);
  const states = await t.run((ctx) =>
    ctx.db.query("walletFundingStates").collect(),
  );
  expect(states).toHaveLength(1);
  expect(states[0]).toMatchObject({
    migrationStatus: "verified",
    migrationWatermarkSequence: 0,
    nonrefundableAvailableCredits: 0,
    refundableAvailableCredits: 0,
    allocatedCredits: 0,
    reversedCredits: 0,
  });
});

it.each([
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
])(
  "preserves financial gates for balance=%s, sequence=%s, debt=%s",
  async (balance, sequence, debt) => {
    const { t, member } = await seed(balance, sequence, debt);
    await member.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_untouched",
    });
    await expect(
      member.query(api.wallets.getMyWallet, { orgSlug: "untouched" }),
    ).rejects.toThrow("Wallet funding checkpoint is not verified");
    expect(
      await t.run((ctx) => ctx.db.query("walletFundingStates").collect()),
    ).toEqual([]);
  },
);

it.each([
  "ledger",
  "payment",
  "lot",
  "legacy lot",
  "state",
  "archived",
  "tombstone",
])(
  "does not certify empty balances with existing %s evidence",
  async (kind) => {
    const { t, organizationId, walletId } = await seed();
    await t.run(async (ctx) => {
      if (kind === "ledger")
        await ctx.db.insert("walletEntries", {
          walletId,
          kind: "admin_adjustment",
          amount: 0,
          refId: "old-ledger",
          sequence: 1,
          createdAt: 1,
        });
      if (kind === "payment" || kind === "legacy lot") {
        const checkoutIntentId = await ctx.db.insert("checkoutIntents", {
          organizationId,
          packId: "pack_10",
          stripePriceId: "price_old",
          amount: 1,
          currency: "usd",
          credits: 10,
          status: "complete",
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        });
        const paymentId = await ctx.db.insert("payments", {
          checkoutIntentId,
          stripeCheckoutSessionId: "cs_old",
          organizationId,
          status: "paid",
          amount: 1,
          currency: "usd",
          grantedCredits: 10,
          reversedCredits: 0,
          createdAt: 1,
          updatedAt: 1,
        });
        if (kind === "legacy lot") {
          await ctx.db.insert("paymentFundingLots", {
            paymentId,
            organizationId,
            grantedCredits: 10,
            availableCredits: 0,
            state: "depleted",
            createdAt: 1,
            updatedAt: 1,
          });
          await ctx.db.delete(paymentId);
        }
      }
      if (kind === "lot")
        await ctx.db.insert("walletFundingLots", {
          walletId,
          organizationId,
          sourceKind: "promotion",
          sourceRef: "old-lot",
          refundable: false,
          grantedCredits: 1,
          availableCredits: 0,
          allocatedCredits: 1,
          reversedCredits: 0,
          state: "depleted",
          createdAt: 1,
          updatedAt: 1,
        });
      if (kind === "state")
        await ctx.db.insert("walletFundingStates", {
          walletId,
          organizationId,
          nonrefundableAvailableCredits: 0,
          refundableAvailableCredits: 0,
          allocatedCredits: 0,
          reversedCredits: 0,
          sequence: 0,
          migrationStatus: "building",
          updatedAt: 1,
        });
      if (kind === "archived")
        await ctx.db.patch(organizationId, { archivedAt: 1 });
      if (kind === "tombstone")
        await ctx.db.insert("organizationTombstones", {
          clerkOrgId: "org_untouched",
          organizationId,
          sourceRevision: 1,
          archivedAt: 1,
        });
      await getOrCreateWallet(ctx, organizationId);
    });
    const states = await t.run((ctx) =>
      ctx.db.query("walletFundingStates").collect(),
    );
    expect(states.filter((s) => s.migrationStatus === "verified")).toEqual([]);
  },
);

it("cannot initialize an untouched wallet while a global migration is fenced", async () => {
  const { t, member } = await seed();
  await t.run((ctx) =>
    ctx.db.insert("financialMigrationJobs", {
      migrationKey: FINANCE_MIGRATION_KEY,
      status: "failed",
      phase: "wallets",
      accumulatorA: 0,
      accumulatorB: 0,
      accumulatorC: 0,
      rowsRead: 0,
      rowsWritten: 0,
      chunks: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  await expect(
    member.mutation(api.organizations.ensureOrganization, {
      clerkOrgId: "org_untouched",
    }),
  ).rejects.toThrow("Finance migration is fenced");
  expect(
    await t.run((ctx) => ctx.db.query("walletFundingStates").collect()),
  ).toEqual([]);
});
