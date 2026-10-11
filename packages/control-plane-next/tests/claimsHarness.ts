import { makeFunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
// Test-only transactions. Copied into .tmp/races/convex for real local OCC tests.
// These prove indexed read/write patterns, not PR 2/3's future domain mutations.
import { internalAction, internalMutation } from "../convex/_generated/server";
import { v } from "convex/values";
import { organization, projectFields, NOW } from "./fixtures";

export const seed = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const org = await ctx.db.insert("organizations", organization(runId));
    const otherOrg = await ctx.db.insert(
      "organizations",
      organization(`${runId}_other`),
    );
    const user = await ctx.db.insert("users", {
      clerkUserId: `user_${runId}`,
      lastClerkEventAt: NOW,
      signupPersonalOrganizationId: org,
    });
    const project = await ctx.db.insert("projects", {
      ...projectFields,
      organizationId: org,
    });
    const wallet = await ctx.db.insert("wallets", {
      owner: { kind: "org", organizationId: org, clerkOrgId: `org_${runId}` },
      ownerKey: `org:org_${runId}`,
      balance: 0,
      sequence: 0,
      promoCredits: 0,
      epoch: 1,
      gateState: "open",
      gateRevision: 1,
      settledThroughEdgeSequence: 0,
    });
    const lot = await ctx.db.insert("fundingLots", {
      walletId: wallet,
      sourceRef: `source_${runId}`,
      sourceKind: "promo",
      grantedCredits: 0,
      movedInCredits: 0,
      movedOutCredits: 0,
      remainingCredits: 0,
      consumedCredits: 0,
      reversedCredits: 0,
      expiredCredits: 0,
      refundable: false,
      priority: 0,
      createdAt: NOW,
      expiryClass: "never",
      state: "depleted",
    });
    return { org, otherOrg, user, project, wallet, lot };
  },
});
export const claim = internalMutation({
  args: {
    kind: v.union(
      v.literal("personal"),
      v.literal("grant"),
      v.literal("source"),
      v.literal("payment"),
      v.literal("ref"),
      v.literal("key"),
      v.literal("route"),
    ),
    runId: v.string(),
    org: v.id("organizations"),
    user: v.id("users"),
    project: v.id("projects"),
    wallet: v.id("wallets"),
    lot: v.id("fundingLots"),
  },
  handler: async (ctx, a) => {
    switch (a.kind) {
      case "personal": {
        const old = await ctx.db
          .query("organizations")
          .withIndex("by_personal_user", (q) =>
            q.eq("personalForClerkUserId", `personal_${a.runId}`),
          )
          .unique();
        if (old) return old._id;
        return ctx.db.insert("organizations", {
          ...organization(`personal_${a.runId}`),
          personalForClerkUserId: `personal_${a.runId}`,
        });
      }
      case "grant": {
        const user = await ctx.db.get(a.user);
        if (!user || user.signupPersonalOrganizationId !== a.org)
          throw new Error("Not eligible");
        if (user.signupGrant) return user.signupGrant.refId;
        const refId = `signup:${user.clerkUserId}`;
        // Claim-only reference transaction. PR 3 atomically adds the actual lot + ledger.
        await ctx.db.patch(a.user, {
          signupGrant: { refId, organizationId: a.org, grantedAt: NOW },
        });
        return refId;
      }
      case "source": {
        const old = await ctx.db
          .query("fundingLotSources")
          .withIndex("by_lot_origin", (q) =>
            q.eq("lotId", a.lot).eq("originLotId", a.lot),
          )
          .unique();
        if (old) return old._id;
        return ctx.db.insert("fundingLotSources", {
          walletId: a.wallet,
          lotId: a.lot,
          originLotId: a.lot,
          sourceRef: `source_${a.runId}`,
          sourceCreatedAt: NOW,
          creditsIn: 0,
          creditsOut: 0,
          remainingCredits: 0,
          consumedCredits: 0,
          reversedCredits: 0,
          expiredCredits: 0,
          state: "depleted",
        });
      }
      case "payment": {
        const ref = `pi_${a.runId}`;
        const old = await ctx.db
          .query("payments")
          .withIndex("by_provider", (q) =>
            q
              .eq("rail", "stripe")
              .eq("providerAccount", "acct_fixture")
              .eq("providerPaymentRef", ref),
          )
          .unique();
        if (old) return old._id;
        return ctx.db.insert("payments", {
          walletId: a.wallet,
          rail: "stripe",
          providerPaymentRef: ref,
          providerAccount: "acct_fixture",
          livemode: false,
          currency: "usd",
          creditFaceValueCents: 1000,
          processingFeeChargedCents: 0,
          feePolicyVersion: "no-surcharge-v1",
          refundFeePolicy: "full_paid_amount",
          amountPaidCents: 1000,
          credits: 100000,
          status: "paid",
          refundedCredits: 0,
          disputedCredits: 0,
          effectiveReversedCredits: 0,
          revision: 1,
          reconciliation: {
            state: "complete",
            targetCredits: 0,
            walletReversedCredits: 0,
            publisherTargetCredits: 0,
            generation: 0,
          },
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      case "ref": {
        const ref = `ref_${a.runId}`;
        const old = await ctx.db
          .query("walletEntries")
          .withIndex("by_ref", (q) => q.eq("refId", ref))
          .unique();
        if (old) {
          if (old.walletId !== a.wallet) throw new Error("Conflict");
          return old._id;
        }
        return ctx.db.insert("walletEntries", {
          walletId: a.wallet,
          refId: ref,
          kind: "usage",
          amount: 0,
          sequence: 1,
          balanceAfter: 0,
          createdAt: NOW,
          immutableFingerprint: "fixture",
        });
      }
      case "key": {
        const keyId = `key_${a.runId}`;
        const old = await ctx.db
          .query("apiKeys")
          .withIndex("by_key", (q) => q.eq("keyId", keyId))
          .unique();
        if (old) {
          if (old.organizationId !== a.org) throw new Error("Conflict");
          return old._id;
        }
        return ctx.db.insert("apiKeys", {
          kind: "key",
          organizationId: a.org,
          clerkOrgId: `org_${a.runId}`,
          keyId,
          keyName: "Fixture",
          ownerUserId: "user_fixture",
          subjectUserId: "user_fixture",
          secretSha256: a.runId,
          verifiedProjectionHash: "fixture",
          verifiedAt: NOW,
          keyFamilyId: keyId,
          budgetId: keyId,
          budgetRevision: 1,
          scopes: [],
          lifecycle: "active",
          edgeRevision: 1,
          updatedAt: NOW,
        });
      }
      case "route": {
        const old = await ctx.db
          .query("routeTombstones")
          .withIndex("by_route", (q) =>
            q.eq("publisherHandle", a.runId).eq("projectSlug", "echo"),
          )
          .unique();
        if (old) {
          if (old.organizationId !== a.org) throw new Error("Conflict");
          return old._id;
        }
        return ctx.db.insert("routeTombstones", {
          publisherHandle: a.runId,
          projectSlug: "echo",
          organizationId: a.org,
          projectId: a.project,
          reservedAt: NOW,
          revision: 1,
        });
      }
    }
  },
});

export const races = internalAction({
  args: {},
  handler: async (ctx) => {
    const runId = `race_${crypto.randomUUID()}`;
    const seedRef = makeFunctionReference<
      "mutation",
      { runId: string },
      {
        org: Id<"organizations">;
        otherOrg: Id<"organizations">;
        user: Id<"users">;
        project: Id<"projects">;
        wallet: Id<"wallets">;
        lot: Id<"fundingLots">;
      }
    >("testClaims:seed");
    const { otherOrg, ...ids } = await ctx.runMutation(seedRef, { runId });
    const kinds = [
      "personal",
      "grant",
      "source",
      "payment",
      "ref",
      "key",
      "route",
    ] as const;
    const claimRef = makeFunctionReference<
      "mutation",
      typeof ids & { kind: (typeof kinds)[number]; runId: string },
      string
    >("testClaims:claim");
    for (const kind of kinds) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          ctx.runMutation(claimRef, { ...ids, kind, runId }),
        ),
      );
      if (new Set(results).size !== 1)
        throw new Error(`${kind} uniqueness failed`);
      if (kind === "key" || kind === "route") {
        let rejected = false;
        try {
          await ctx.runMutation(claimRef, {
            ...ids,
            org: otherOrg,
            kind,
            runId,
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("Conflict"))
            throw error;
          rejected = true;
        }
        if (!rejected)
          throw new Error(`${kind} cross-owner collision accepted`);
      }
    }
    return { passed: [...kinds], concurrentClaimants: 8 };
  },
});
