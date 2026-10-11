import { ConvexError } from "convex/values";
import { parseSpec, matchOperation } from "@zevium/shared";
import type { MutationCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";
import { settlement, type Settlement } from "../../contracts/settlement";
import { fingerprint, verifyAdmission } from "../../contracts/transport";
import { appendWalletEntry, facts, getWallet } from "./walletLedger";
import { consumeSlices, validateSlices, type Slice } from "./lots";
import { recordEarnings, recordRollups } from "./rollups";
export type Outcome =
  | { refId: string; status: "applied" | "already_applied" }
  | { refId: string; status: "rejected"; reason: string; retryable: boolean };
const reject = (refId: string, reason: string, retryable = false): Outcome => ({
  refId,
  status: "rejected",
  reason,
  retryable,
});
function id<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  value: string,
): Id<T> {
  const result = ctx.db.normalizeId(table, value);
  if (!result) throw new ConvexError("Settlement identity rejected");
  return result;
}
/** One event per mutation is the conservative transaction budget. Validation never writes. */
export async function settleOne(
  ctx: MutationCtx,
  value: unknown,
): Promise<Outcome> {
  const parsed = settlement.safeParse(value);
  if (!parsed.success) return reject("invalid", "Invalid settlement");
  const event = parsed.data,
    now = Date.now();
  const secret = process.env.NEXT_ADMISSION_SECRET;
  if (!secret || !process.env.NEXT_DEPLOYMENT_ID)
    return reject(event.settleRefId, "Settlement unavailable", true);
  if (
    event.deploymentId !== process.env.NEXT_DEPLOYMENT_ID ||
    !(await verifyAdmission(event, secret))
  )
    return reject(event.settleRefId, "Admission evidence rejected");
  const immutableFingerprint = await fingerprint(facts(event));
  const prior = await ctx.db
    .query("usageEvents")
    .withIndex("by_ref", (q) => q.eq("settleRefId", event.settleRefId))
    .unique();
  if (prior)
    return prior.immutableFingerprint === immutableFingerprint
      ? { refId: event.settleRefId, status: "already_applied" }
      : reject(event.settleRefId, "Settlement facts changed");
  // Everything after preflight must propagate exceptions: Convex rolls back the entire event.
  let evidence: Awaited<ReturnType<typeof validateEvidence>>;
  try {
    evidence = await validateEvidence(ctx, event, now);
  } catch {
    return reject(event.settleRefId, "Settlement evidence rejected");
  }
  const { wallet, project, version, slices } = evidence;
  if (
    wallet.epoch !== event.epoch ||
    wallet.gateState === "closed" ||
    (wallet.close?.ackAt !== undefined && wallet.gateState === "closing")
  )
    return reject(event.settleRefId, "Stale wallet epoch");
  if (event.edgeSequence !== wallet.settledThroughEdgeSequence + 1)
    return reject(
      event.settleRefId,
      "Finalization sequence gap",
      event.edgeSequence > wallet.settledThroughEdgeSequence + 1,
    );
  const consumed = event.billingOutcome === "settled" ? slices : [];
  const usageId = await ctx.db.insert("usageEvents", {
    publicId: `usage:${event.reservationId}`,
    walletId: wallet._id,
    consumerOrganizationId: wallet.owner.organizationId,
    publisherOrganizationId: project.organizationId,
    projectId: project._id,
    specVersionId: version._id,
    projectName: project.name,
    projectSlug: project.slug,
    operationId: event.operationId,
    method: event.method,
    endpoint: event.endpoint,
    at: event.at,
    status: event.status,
    latencyMs: event.latencyMs,
    settleRefId: event.settleRefId,
    reservationId: event.reservationId,
    epoch: event.epoch,
    edgeSequence: event.edgeSequence,
    admissionFingerprint: event.admissionFingerprint,
    immutableFingerprint,
    pricingDecision: event.pricingDecision,
    listedCostCredits: event.listedCostCredits,
    heldCredits: event.heldCredits,
    credits: event.credits,
    billingOutcome: event.billingOutcome,
    qualityOutcome: event.qualityOutcome,
    ambiguous: event.ambiguous,
    keyId: event.keyId,
    keyFamilyId: event.keyFamilyId,
    ownerUserId: event.ownerUserId,
    budgetPeriod: event.budgetPeriod,
    budgetUsedBefore: event.budgetUsedBefore,
    budgetReservedBefore: event.budgetReservedBefore,
    monthlyCapCredits: event.monthlyCapCredits,
    freeTierLimit: event.freeTierLimit,
    freeTierUsedBefore: event.freeTierUsedBefore,
    publisherIdempotencyKey: event.publisherIdempotencyKey,
    fundingSlices: consumed,
  });
  if (event.credits) {
    const promo = await consumeSlices(ctx, consumed);
    await appendWalletEntry(
      ctx,
      {
        walletId: wallet._id,
        kind: "usage",
        amount: -event.credits,
        refId: event.settleRefId,
        usageEventId: usageId,
      },
      -promo,
    );
  }
  const usage = (await ctx.db.get(usageId))!;
  await recordEarnings(ctx, usage, now);
  await recordRollups(ctx, usage, now);
  await ctx.db.patch(wallet._id, {
    settledThroughEdgeSequence: event.edgeSequence,
  });
  return { refId: event.settleRefId, status: "applied" };
}
async function validateEvidence(
  ctx: MutationCtx,
  event: Settlement,
  now: number,
) {
  const wallet = await getWallet(ctx, id(ctx, "wallets", event.walletId));
  const project = await ctx.db.get(id(ctx, "projects", event.projectId));
  const version = await ctx.db.get(
    id(ctx, "specVersions", event.specVersionId),
  );
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_key", (q) => q.eq("keyId", event.keyId))
    .unique();
  if (
    !project ||
    !version ||
    version.projectId !== project._id ||
    version.version !== event.specVersion ||
    version.contentHash !== event.specDigest ||
    project.organizationId !== event.publisherOrganizationId ||
    wallet.ownerKey !== event.ownerKey ||
    wallet.owner.clerkOrgId !== event.consumerClerkOrgId ||
    !key ||
    key.kind !== "key" ||
    key.organizationId !== wallet.owner.organizationId ||
    key.ownerUserId !== event.ownerUserId ||
    key.subjectUserId !== event.ownerUserId ||
    key.keyFamilyId !== event.keyFamilyId ||
    event.admittedAt < version.publishedAt ||
    event.at > now + 30_000 ||
    event.budgetPeriod !== new Date(event.admittedAt).toISOString().slice(0, 7)
  )
    throw new ConvexError("Settlement identity rejected");
  // Mutable archive, visibility, key caps/revocation and latestVersion are admission policy, not late settlement policy.
  const op = matchOperation(
    parseSpec(version.spec),
    event.method,
    event.endpoint,
  );
  if (
    !op ||
    op.pricing.token ||
    op.operationId !== event.operationId ||
    op.pathTemplate !== event.endpoint ||
    op.pricing.cost !== event.listedCostCredits ||
    event.freeTierLimit !== op.pricing.freeTier ||
    (event.pricingDecision === "free_tier" && !op.pricing.freeTier)
  )
    throw new ConvexError("Immutable pricing evidence rejected");
  const slices: Slice[] = event.fundingSlices.map((s) => ({
    ...s,
    lotId: id(ctx, "fundingLots", s.lotId),
    originLotId: id(ctx, "fundingLots", s.originLotId),
    paymentId: s.paymentId ? id(ctx, "payments", s.paymentId) : undefined,
  }));
  await validateSlices(
    ctx,
    wallet._id,
    slices,
    event.admittedAt,
    event.credits > 0,
  );
  return { wallet, project, version, slices };
}
