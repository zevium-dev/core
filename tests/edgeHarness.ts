import { appendWalletEntry } from "../convex/money/walletLedger";
import { financeFixture } from "./financeFixtures";
import {
  projectAdjustment,
  reconcilePaymentPage,
} from "../convex/money/adjustments";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../convex/_generated/server";
import { moneyFixture, assertWallet } from "./moneyFixtures";
import { sha256Hex } from "@zevium/shared";
import { requestClose, finishClose } from "../convex/money/barrier";
import { revokeKey } from "../convex/lib/keys";
export const seed = internalMutation({
  args: {
    run: v.string(),
    amounts: v.optional(v.array(v.number())),
    paid: v.optional(v.boolean()),
    house: v.optional(v.boolean()),
  },
  handler: async (ctx, { run, amounts, paid, house }) => {
    const f = paid
      ? await financeFixture(ctx, run, 5, 0)
      : await moneyFixture(ctx, run, amounts ?? [100], 5);
    const wallet = (await ctx.db.get(f.walletId))!,
      org = (await ctx.db.get(f.publisher))!;
    const version = (await ctx.db.get(f.version))!;
    const spec = JSON.parse(version.spec);
    delete spec.paths["/echo"].post["x-zevium-free-tier"];
    spec.paths["/echo"].post["x-zevium-cost"] = 5;
    spec.paths["/echo"].post.responses["200"].content = {
      "application/json": {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean", example: true } },
        },
      },
    };
    const text = JSON.stringify(spec);
    await ctx.db.patch(f.version, {
      spec: text,
      contentHash: await sha256Hex(text),
    });
    await ctx.db.patch(f.project, {
      status: "published",
      houseOperated: house ?? false,
      visibility: "public",
      desiredVisibility: "public",
      latestVersionId: f.version,
      publicationGeneration: 1,
      discoverable: true,
      endpointCount: 2,
      minCost: 0,
      maxCost: 5,
    });
    await ctx.db.insert("routeTombstones", {
      publisherHandle: org.publicHandle,
      projectSlug: "echo",
      organizationId: f.publisher,
      projectId: f.project,
      reservedAt: Date.now(),
      revision: 1,
    });
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", f.keyId))
      .unique();
    const secret = `ak_${run}`;
    await ctx.db.patch(key!._id, { secretSha256: await sha256Hex(secret) });
    return {
      ...f,
      orgId: wallet.owner.clerkOrgId,
      publisherOrgId: org.clerkOrgId,
      handle: org.publicHandle,
      secret,
    };
  },
});
export const inspect = internalQuery({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const audit = await assertWallet(ctx, walletId);
    const wallet = await ctx.db.get(walletId);
    const usage = await ctx.db
      .query("usageEvents")
      .withIndex("by_wallet_edge", (q) => q.eq("walletId", walletId))
      .collect();
    const cases = await ctx.db.query("financeReconciliationCases").collect();
    const earnings = await ctx.db.query("publisherEarnings").collect();
    return { audit, wallet, usage, cases, earnings };
  },
});
export const close = internalMutation({
  args: { walletId: v.id("wallets"), id: v.string() },
  handler: (ctx, a) => requestClose(ctx, a.walletId, a.id, "refund"),
});
export const finish = internalMutation({
  args: { walletId: v.id("wallets"), id: v.string() },
  handler: (ctx, a) => finishClose(ctx, a.walletId, a.id),
});
export const revoke = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, a) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", a.keyId))
      .unique();
    if (key?.kind !== "key") throw new Error("Missing key");
    return revokeKey(ctx, key);
  },
});
export const poison = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, a) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key", (q) => q.eq("keyId", a.keyId))
      .unique();
    if (key?.kind !== "key") throw new Error("Missing key");
    await ctx.db.patch(key._id, { ownerUserId: "changed-evidence" });
  },
});

export const refund = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const payment = (await ctx.db.get(paymentId))!;
    await projectAdjustment(ctx, paymentId, payment.revision, {
      kind: "refund",
      status: "pending",
      sourceRef: `refund:${paymentId}`,
      amountCents: payment.amountPaidCents,
    });
    const current = (await ctx.db.get(paymentId))!;
    return reconcilePaymentPage(
      ctx,
      paymentId,
      current.reconciliation.generation,
    );
  },
});
export const advanceRefund = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const payment = (await ctx.db.get(paymentId))!;
    return reconcilePaymentPage(
      ctx,
      paymentId,
      payment.reconciliation.generation,
    );
  },
});
export const archive = internalMutation({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const wallet = (await ctx.db.get(walletId))!;
    await ctx.db.patch(wallet.owner.organizationId, { archivedAt: Date.now() });
    return requestClose(ctx, walletId, `archive:${walletId}`, "archive");
  },
});
/** Inject a broken external reclaim to exercise the authentic-unsettleable path.
 * Production reclaims cannot bypass the barrier; fixture keeps ledger/source
 * conservation while deliberately violating the active admission's evidence. */
export const deplete = internalMutation({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const sources = await ctx.db
      .query("fundingLotSources")
      .withIndex("by_wallet_spend", (q) =>
        q.eq("walletId", walletId).eq("state", "available"),
      )
      .take(32);
    for (const source of sources) {
      const lot = (await ctx.db.get(source.lotId))!,
        amount = source.remainingCredits;
      await ctx.db.patch(source._id, {
        remainingCredits: 0,
        reversedCredits: source.reversedCredits + amount,
        state: "depleted",
      });
      await ctx.db.patch(lot._id, {
        remainingCredits: lot.remainingCredits - amount,
        reversedCredits: lot.reversedCredits + amount,
        state: "depleted",
      });
      await appendWalletEntry(ctx, {
        walletId,
        refId: `fixture-deplete:${source._id}`,
        kind: "reversal",
        amount: -amount,
        lotId: lot._id,
        originLotId: source.originLotId,
        adjustment: { kind: "admin", ref: "fixture-deplete" },
      });
    }
  },
});
