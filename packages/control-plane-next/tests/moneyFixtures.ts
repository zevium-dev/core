import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { ensureWallet } from "../convex/money/walletLedger";
import { grantLot, allocate } from "../convex/money/lots";
import { insertKey } from "../convex/lib/keys";
import { sha256Hex } from "@zevium/shared";
import { organization, projectFields, admitted, SECRET } from "./fixtures";
import { admissionFingerprint, admissionFacts } from "../contracts/transport";
import type { Settlement } from "../contracts/settlement";
export async function moneyFixture(
  ctx: MutationCtx,
  run = "money",
  amounts = [100],
  cost = 5,
) {
  const consumer = await ctx.db.insert(
    "organizations",
    organization(`${run}-consumer`),
  );
  const publisher = await ctx.db.insert(
    "organizations",
    organization(`${run}-publisher`),
  );
  const wallet = await ensureWallet(ctx, (await ctx.db.get(consumer))!);
  const project = await ctx.db.insert("projects", {
    ...projectFields,
    organizationId: publisher,
  });
  const spec = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Echo", version: "1.0.0" },
    servers: [{ url: "https://example.com" }],
    paths: {
      "/echo": {
        post: {
          operationId: "echo",
          "x-zevium-cost": cost,
          "x-zevium-free-tier": 2,
          responses: { "200": { description: "OK" } },
        },
      },
      "/free": {
        get: {
          operationId: "free",
          "x-zevium-cost": 0,
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });
  const specDigest = await sha256Hex(spec);
  const version = await ctx.db.insert("specVersions", {
    projectId: project,
    version: "1.0.0",
    spec,
    contentHash: specDigest,
    publishedAt: Date.now() - 1000,
  });
  const key = await insertKey(
    ctx,
    (await ctx.db.get(consumer))!,
    {
      clerkKeyId: `key_${run}`,
      clerkOrgId: wallet.owner.clerkOrgId,
      ownerUserId: `user_${run}`,
      subjectUserId: `user_${run}`,
      secretSha256: await sha256Hex(run),
      budgetId: `budget_${run}`,
      budgetRevision: 1,
      lifecycle: "active",
      monthlyCapCredits: null,
      graceUntil: null,
      expiresAt: null,
      scopes: ["gateway:execute"],
    },
    Date.now(),
  );
  const lots = [];
  for (const [i, credits] of amounts.entries())
    lots.push(
      (
        await grantLot(ctx, {
          walletId: wallet._id,
          sourceKind: "admin",
          sourceRef: `${run}:${i}`,
          credits,
        })
      ).lot._id,
    );
  return {
    walletId: wallet._id,
    consumer,
    publisher,
    project,
    version,
    specDigest,
    keyId: key.keyId,
    keyFamilyId: key.keyFamilyId,
    ownerUserId: key.ownerUserId,
    cost,
    lots,
  };
}
export type MoneyFixture = Awaited<ReturnType<typeof moneyFixture>>;
export async function eventFor(
  ctx: QueryCtx,
  f: MoneyFixture,
  sequence = 1,
  overrides: Partial<Settlement> = {},
): Promise<Settlement> {
  const wallet = (await ctx.db.get(f.walletId))!;
  const event: Settlement = {
    ...admitted,
    deploymentId: "next-fixture",
    walletId: wallet._id,
    ownerKey: wallet.ownerKey,
    consumerClerkOrgId: wallet.owner.clerkOrgId,
    publisherOrganizationId: f.publisher,
    projectId: f.project,
    specVersionId: f.version,
    specDigest: f.specDigest,
    keyId: f.keyId,
    keyFamilyId: f.keyFamilyId,
    ownerUserId: f.ownerUserId,
    epoch: wallet.epoch,
    edgeSequence: sequence,
    reservationId: `${wallet._id}:${wallet.epoch}:${sequence}`,
    settleRefId: `settle:${wallet._id}:${wallet.epoch}:${sequence}`,
    listedCostCredits: f.cost,
    heldCredits: f.cost,
    credits: f.cost,
    fundingSlices: await allocate(ctx, f.walletId, f.cost),
    freeTierLimit: 2,
    budgetPeriod: new Date().toISOString().slice(0, 7),
    admittedAt: Date.now(),
    at: Date.now(),
    status: 200,
    latencyMs: 10,
    billingOutcome: "settled",
    qualityOutcome: "success",
    ambiguous: false,
    admissionFingerprint: "0".repeat(64),
    ...overrides,
  };
  event.admissionFingerprint = await admissionFingerprint(
    admissionFacts(event),
    SECRET,
  );
  return JSON.parse(JSON.stringify(event)) as Settlement;
}
export async function assertWallet(
  ctx: Pick<QueryCtx, "db">,
  walletId: Id<"wallets">,
) {
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  const wallet = (await ctx.db.get(walletId))!;
  const entries = await ctx.db
    .query("walletEntries")
    .withIndex("by_wallet_sequence", (q) => q.eq("walletId", walletId))
    .collect();
  let balance = 0;
  entries.forEach((entry, i) => {
    balance += entry.amount;
    check(
      entry.sequence === i + 1 &&
        entry.balanceAfter === balance &&
        balance >= 0,
      "Journal conservation",
    );
  });
  check(
    balance === wallet.balance && entries.length === wallet.sequence,
    "Wallet conservation",
  );
  const lots = (await ctx.db.query("fundingLots").collect()).filter(
    (l) => l.walletId === walletId,
  );
  check(
    lots.reduce((n, l) => n + l.remainingCredits, 0) === balance,
    "Lot/wallet conservation",
  );
  check(
    lots
      .filter((l) => l.sourceKind === "promo")
      .reduce((n, l) => n + l.remainingCredits, 0) === wallet.promoCredits,
    "Promo conservation",
  );
  for (const lot of lots) {
    check(
      lot.grantedCredits + lot.movedInCredits ===
        lot.remainingCredits +
          lot.consumedCredits +
          lot.reversedCredits +
          lot.expiredCredits +
          lot.movedOutCredits,
      "Lot conservation",
    );
    const sources = await ctx.db
      .query("fundingLotSources")
      .withIndex("by_lot_origin", (q) => q.eq("lotId", lot._id))
      .collect();
    for (const source of sources)
      check(
        source.creditsIn ===
          source.creditsOut +
            source.remainingCredits +
            source.consumedCredits +
            source.reversedCredits +
            source.expiredCredits,
        "Source conservation",
      );
    for (const field of [
      "remainingCredits",
      "consumedCredits",
      "reversedCredits",
      "expiredCredits",
    ] as const)
      check(
        sources.reduce((n, s) => n + s[field], 0) === lot[field],
        `Source/container ${field}`,
      );
  }
  const usage = await ctx.db.query("usageEvents").collect();
  const earnings = await ctx.db.query("publisherEarnings").collect();
  const rollups = await ctx.db.query("usageRollups").collect();
  check(
    earnings.reduce((n, e) => n + e.grossCredits, 0) ===
      usage
        .filter((e) => e.billingOutcome === "settled")
        .reduce((n, e) => n + e.credits, 0),
    "Usage/earnings gross conservation",
  );
  check(
    rollups
      .filter(
        (e) =>
          e.kind === "lifetime" &&
          e.scope === "publisher" &&
          e.dimension === "total",
      )
      .reduce((n, e) => n + (e.kind === "lifetime" ? e.netAtoms : 0), 0) ===
      earnings.reduce((n, e) => n + e.netAtoms, 0),
    "Earnings/lifetime net conservation",
  );
  return { balance, entries: entries.length, lots: lots.length };
}
export async function paidLot(
  ctx: MutationCtx,
  walletId: Id<"wallets">,
  sourceRef: string,
  credits: number,
) {
  const paymentId = await ctx.db.insert("payments", {
    walletId,
    rail: "stripe",
    providerPaymentRef: sourceRef,
    providerAccount: "fixture",
    livemode: false,
    currency: "usd",
    creditFaceValueCents: credits / 100,
    processingFeeChargedCents: 0,
    amountPaidCents: credits / 100,
    feePolicyVersion: "fixture",
    refundFeePolicy: "full_paid_amount",
    credits,
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return grantLot(ctx, {
    walletId,
    sourceRef,
    sourceKind: "payment",
    paymentId,
    credits,
  });
}
