import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { moneyFixture } from "./moneyFixtures";
import { projectPaid } from "../convex/billing";
import { acknowledgeDrain } from "../convex/money/barrier";
import type { PaidFact } from "../convex/lib/stripe";
export const PLATFORM = "acct_fixture";
export async function prepareFinanceFixture(
  ctx: MutationCtx,
  run = "finance",
  cost = 1000,
  fee = 20,
) {
  const f = await moneyFixture(ctx, run, [], cost);
  const intent = await ctx.db.insert("checkoutIntents", {
    organizationId: f.consumer,
    packId: "pack_10",
    credits: 100000,
    creditFaceValueCents: 1000,
    processingFeeQuotedCents: fee,
    totalCents: 1000 + fee,
    currency: "usd",
    feePolicyVersion: "fixture",
    feeQuoteExpiresAt: Date.now() + 1800000,
    stripeCreditPriceId: `price_${run}`,
    feeLinePriceId: fee ? `price_fee_${run}` : undefined,
    stripeCustomerId: `cus_${run}`,
    status: "open",
    createdAt: Date.now(),
    expiresAt: Date.now() + 1800000,
  });
  const paid: PaidFact = {
    intentId: intent,
    sessionId: `cs_${run}`,
    paymentIntentId: `pi_${run}`,
    chargeId: `ch_${run}`,
    customerId: `cus_${run}`,
    currency: "usd",
    livemode: false,
    providerAccount: PLATFORM,
    amountCents: 1000 + fee,
    actualFeeCents: 35,
    lines: [
      { priceId: `price_${run}`, quantity: 1, amountCents: 1000 },
      ...(fee
        ? [
            {
              priceId: `price_fee_${run}`,
              quantity: 1 as const,
              amountCents: fee,
            },
          ]
        : []),
    ],
  };

  await ctx.db.patch(f.publisher, {
    connect: {
      accountId: `acct_${run}`,
      platformAccountId: PLATFORM,
      livemode: false,
      status: "active",
      requirements: [],
      updatedAt: Date.now(),
    },
  });
  return { ...f, paid };
}
export async function drain(ctx: MutationCtx, walletId: Id<"wallets">) {
  const w = (await ctx.db.get(walletId))!,
    c = w.close!;
  if (w.gateState === "maintenance") return w;
  return acknowledgeDrain(ctx, {
    protocolVersion: 2,
    deploymentId: "next-fixture",
    walletId,
    ownerKey: w.ownerKey,
    epoch: w.epoch,
    gateRevision: w.gateRevision,
    closeId: c.id,
    reason: c.reason,
    requestedAt: c.requestedAt,
    edgeFinalSequence: w.settledThroughEdgeSequence,
    settledThroughEdgeSequence: w.settledThroughEdgeSequence,
    sealedAt: Date.now(),
  });
}

export async function financeFixture(
  ctx: MutationCtx,
  run = "finance",
  cost = 1000,
  fee = 20,
) {
  const f = await prepareFinanceFixture(ctx, run, cost, fee);
  return { ...f, paymentId: await projectPaid(ctx, f.paid) };
}
