/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { assertQuarantinedTestPayout } from "./financeRecovery";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");
const checkoutProof = {
  kind: "foreign_checkout",
  sessionId: "cs_foreign",
  paymentIntentId: "pi_foreign",
  chargeId: "ch_foreign",
  clerkOrgId: "org_foreign",
  checkoutIntentId: "other-deployment-id",
  livemode: false,
  clerkStatus: 404,
} as const;
const payoutProof = {
  kind: "unlinked_test_payout",
  id: "po_foreign",
  accountId: "acct_foreign",
  amount: 100,
  currency: "usd",
  status: "paid",
  livemode: false,
  purpose: "zevium_usd_settlement_e2e",
} as const;
async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    event: await ctx.db.insert("paymentEvents", {
      stripeEventId: "evt_foreign",
      stripeAccount: "platform",
      eventType: "checkout.session.completed",
      objectId: "cs_foreign",
      status: "failed",
      attempts: 1,
      deliveries: 1,
      receivedAt: 1,
      lastError: "Unknown Stripe checkout session",
    }),
    payout: await ctx.db.insert("connectedPayouts", {
      stripePayoutId: "po_foreign",
      stripeConnectedAccountId: "acct_foreign",
      amount: 100,
      currency: "usd",
      status: "paid",
      updatedAt: 1,
    }),
  }));
  return { t, ids };
}
describe("operator foreign test record isolation", () => {
  it("retains original records and idempotent evidence without posting money", async () => {
    const { t, ids } = await seed();
    const eventCase = await t.mutation(
      internal.financeRecovery.recordQuarantine,
      {
        source: { kind: "event", id: "evt_foreign" },
        proof: checkoutProof,
        providerRequestIds: ["req_checkout"],
      },
    );
    const payoutCase = await t.mutation(
      internal.financeRecovery.recordQuarantine,
      {
        source: { kind: "payout", id: "po_foreign" },
        proof: payoutProof,
        providerRequestIds: ["req_payout"],
      },
    );
    expect(
      await t.mutation(internal.financeRecovery.recordQuarantine, {
        source: { kind: "event", id: "evt_foreign" },
        proof: checkoutProof,
        providerRequestIds: ["req_checkout"],
      }),
    ).toBe(eventCase);
    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(ids.event),
      payout: await ctx.db.get(ids.payout),
      cases: await ctx.db.query("financeReconciliationCases").collect(),
      wallets: await ctx.db.query("walletEntries").collect(),
    }));
    expect(rows.event).toMatchObject({
      status: "ignored",
      lastError: "Unknown Stripe checkout session",
      quarantineCaseId: eventCase,
    });
    expect(rows.payout).toMatchObject({
      amount: 100,
      currency: "usd",
      status: "paid",
      quarantineCaseId: payoutCase,
    });
    expect(rows.cases).toHaveLength(2);
    expect(JSON.parse(rows.cases[0].resolution!).original.status).toBe(
      "failed",
    );
    expect(rows.wallets).toEqual([]);
    await t.run(async (ctx) => {
      const payout = await ctx.db.get(ids.payout);
      if (!payout) throw new Error("Fixture missing");
      await assertQuarantinedTestPayout(ctx, payout);
    });
    await t.run((ctx) => ctx.db.patch(ids.payout, { amount: 101 }));
    await expect(
      t.run(async (ctx) => {
        const payout = await ctx.db.get(ids.payout);
        if (!payout) throw new Error("Fixture missing");
        await assertQuarantinedTestPayout(ctx, payout);
      }),
    ).rejects.toThrow("differs from provider evidence");
  });
  it.each(["organization", "tombstone", "checkout", "leased"] as const)(
    "refuses to ignore a local or active Checkout receipt: %s",
    async (fault) => {
      const { t, ids } = await seed();
      await t.run(async (ctx) => {
        if (fault === "organization")
          await ctx.db.insert("organizations", {
            clerkOrgId: "org_foreign",
            slug: "local",
            name: "Local",
          });
        if (fault === "tombstone")
          await ctx.db.insert("organizationTombstones", {
            clerkOrgId: "org_foreign",
            archivedAt: 1,
            sourceRevision: 1,
          });
        if (fault === "checkout") {
          const org = await ctx.db.insert("organizations", {
            clerkOrgId: "org_local",
            slug: "local",
            name: "Local",
          });
          await ctx.db.insert("checkoutIntents", {
            organizationId: org,
            packId: "pack_10",
            stripePriceId: "price_local",
            amount: 1000,
            currency: "usd",
            credits: 100000,
            status: "complete",
            createdAt: 1,
            updatedAt: 1,
            expiresAt: 2,
            stripeCheckoutSessionId: "cs_foreign",
          });
        }
        if (fault === "leased")
          await ctx.db.patch(ids.event, {
            status: "processing",
            leaseExpiresAt: Date.now() + 60000,
          });
      });
      await expect(
        t.mutation(internal.financeRecovery.recordQuarantine, {
          source: { kind: "event", id: "evt_foreign" },
          proof: checkoutProof,
          providerRequestIds: ["req_checkout"],
        }),
      ).rejects.toThrow(/belongs to this deployment|unleased legacy/);
      expect(
        await t.run((ctx) =>
          ctx.db.query("financeReconciliationCases").collect(),
        ),
      ).toEqual([]);
    },
  );
  it.each(["profile", "claim", "wrong-amount", "missing-evidence"] as const)(
    "refuses an owned or unproven payout: %s",
    async (fault) => {
      const { t } = await seed();
      await t.run(async (ctx) => {
        const org = await ctx.db.insert("organizations", {
          clerkOrgId: "org_local",
          slug: "local",
          name: "Local",
        });
        if (fault === "profile")
          await ctx.db.insert("organizationPayments", {
            organizationId: org,
            stripeConnectedAccountId: "acct_foreign",
            detailsSubmitted: true,
            chargesEnabled: true,
            payoutsEnabled: true,
            requirements: [],
            updatedAt: 1,
          });
        if (fault === "claim")
          await ctx.db.insert("connectedAccountClaims", {
            organizationId: org,
            stripeConnectedAccountId: "acct_foreign",
            livemode: false,
            claimedAt: 1,
          });
      });
      await expect(
        t.mutation(internal.financeRecovery.recordQuarantine, {
          source: { kind: "payout", id: "po_foreign" },
          proof: {
            ...payoutProof,
            amount: fault === "wrong-amount" ? 101 : 100,
          },
          providerRequestIds:
            fault === "missing-evidence" ? [] : ["req_payout"],
        }),
      ).rejects.toThrow(
        /belongs to this deployment|differs from provider proof|evidence is required/,
      );
    },
  );
  it("ignores payout projections for unowned connected accounts", async () => {
    const { t } = await seed();
    expect(
      await t.mutation(internal.payouts.projectConnectedPayout, {
        stripeConnectedAccountId: "acct_unknown",
        stripePayoutId: "po_unknown",
        amount: 100,
        currency: "usd",
        status: "paid",
      }),
    ).toEqual({ owned: false });
    expect(
      await t.run((ctx) => ctx.db.query("connectedPayouts").collect()),
    ).toHaveLength(1);
  });
});
