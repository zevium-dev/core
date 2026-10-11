import { readRing } from "@zevium/shared/edge/replication";
import { ConvexError } from "convex/values";
import { parseSpec, matchOperation } from "@zevium/shared";
import type { MutationCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";
import { settlement, type Settlement } from "../../contracts/settlement";
import {
  fingerprint,
  verify,
  verifyAdmission,
} from "../../contracts/transport";
import { appendWalletEntry, facts, getWallet } from "./walletLedger";
import { consumeSlices, validateSlices, type Slice } from "./lots";
import { recordEarnings, recordRollups } from "./rollups";
export type Outcome =
  | { refId: string; status: "applied" | "already_applied" | "exception" }
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
  const ring = process.env.NEXT_ADMISSION_KEYS
    ? readRing(process.env.NEXT_ADMISSION_KEYS)
    : null;
  const secret = ring
    ? event.admissionKeyId && Object.hasOwn(ring.keys, event.admissionKeyId)
      ? ring.keys[event.admissionKeyId]
      : undefined
    : process.env.NEXT_ADMISSION_SECRET;
  if (!secret || !process.env.NEXT_DEPLOYMENT_ID)
    return reject(event.settleRefId, "Settlement unavailable", true);
  if (
    event.deploymentId !== process.env.NEXT_DEPLOYMENT_ID ||
    !(await verifyAdmission(event, secret))
  )
    return reject(event.settleRefId, "Admission evidence rejected");
  if (event.admissionKeyId && !ring)
    return reject(event.settleRefId, "Settlement unavailable", true);
  const immutableFingerprint = await fingerprint(facts(event));
  const prior = await ctx.db
    .query("usageEvents")
    .withIndex("by_ref", (q) => q.eq("settleRefId", event.settleRefId))
    .unique();
  if (prior)
    return prior.immutableFingerprint === immutableFingerprint
      ? {
          refId: event.settleRefId,
          status:
            prior.billingOutcome === "exception"
              ? "exception"
              : "already_applied",
        }
      : reject(event.settleRefId, "Settlement facts changed");
  if (ring) {
    const { finalFingerprint, ...final } = event;
    if (
      !finalFingerprint ||
      !(await verify(
        { purpose: "final:v2", facts: final },
        finalFingerprint,
        secret,
      ))
    )
      return reject(event.settleRefId, "Final evidence rejected");
  }
  const walletId = ctx.db.normalizeId("wallets", event.walletId);
  if (!walletId) return reject(event.settleRefId, "Wallet identity rejected");
  const wallet = await getWallet(ctx, walletId);
  if (
    wallet.ownerKey !== event.ownerKey ||
    wallet.owner.clerkOrgId !== event.consumerClerkOrgId
  )
    return reject(event.settleRefId, "Wallet identity rejected");
  if (wallet.epoch !== event.epoch)
    return reject(event.settleRefId, "Stale wallet epoch");
  if (event.edgeSequence !== wallet.settledThroughEdgeSequence + 1)
    return reject(
      event.settleRefId,
      "Finalization sequence gap",
      event.edgeSequence > wallet.settledThroughEdgeSequence + 1,
    );
  if (
    wallet.gateState === "closed" ||
    wallet.gateState === "maintenance" ||
    (wallet.close?.ackAt !== undefined && wallet.gateState === "closing")
  )
    return recordException(
      ctx,
      event,
      wallet,
      immutableFingerprint,
      now,
      "Authentic final arrived after wallet gate closed",
    );
  if (event.recoveryUnknown)
    return recordException(
      ctx,
      event,
      wallet,
      immutableFingerprint,
      now,
      "Worker lost final outcome during restart",
    );
  // Only explicit evidence failures become exceptions. Infrastructure failures roll back/retry.
  let evidence: Awaited<ReturnType<typeof validateEvidence>>;
  try {
    evidence = await validateEvidence(ctx, event);
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    return recordException(
      ctx,
      event,
      wallet,
      immutableFingerprint,
      now,
      typeof error.data === "string"
        ? error.data
        : "Settlement evidence rejected",
    );
  }
  const { project, version, slices } = evidence;
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
  const promoCostCredits = await recordEarnings(ctx, usage, now);
  await ctx.db.patch(usageId, { promoCostCredits });
  await recordRollups(ctx, { ...usage, promoCostCredits }, now);
  await ctx.db.patch(wallet._id, {
    settledThroughEdgeSequence: event.edgeSequence,
  });
  return { refId: event.settleRefId, status: "applied" };
}
async function validateEvidence(ctx: MutationCtx, event: Settlement) {
  if (
    !Number.isFinite(new Date(event.at).getTime()) ||
    !Number.isFinite(new Date(event.admittedAt).getTime()) ||
    event.credits > Math.floor(Number.MAX_SAFE_INTEGER / 10000)
  )
    throw new ConvexError("Settlement accounting range rejected");
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

/** A signed, contiguous final is durably accounted for even when its debit evidence is unusable.
 * No synthetic grant, consumer debt or publisher earnings. Raw evidence stays internal.
 */
async function recordException(
  ctx: MutationCtx,
  event: Settlement,
  wallet: Awaited<ReturnType<typeof getWallet>>,
  immutableFingerprint: string,
  now: number,
  reason: string,
): Promise<Outcome> {
  const caseId = await ctx.db.insert("financeReconciliationCases", {
    rowKind: "case",
    kind: "settlement_exception",
    status: "open",
    reason,
    organizationId: wallet.owner.organizationId,
    operationId: event.settleRefId,
    candidateCount: 1,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("financeReconciliationCases", {
    rowKind: "candidate",
    caseId,
    value: JSON.stringify(event),
    createdAt: now,
  });
  // Preserve malformed identity evidence on the case; never invent typed IDs.
  const projectId = ctx.db.normalizeId("projects", event.projectId);
  const versionId = ctx.db.normalizeId("specVersions", event.specVersionId);
  const publisherId = ctx.db.normalizeId(
    "organizations",
    event.publisherOrganizationId,
  );
  const project = projectId ? await ctx.db.get(projectId) : null;
  await ctx.db.insert("usageEvents", {
    publicId: `usage:${event.reservationId}`,
    walletId: wallet._id,
    consumerOrganizationId: wallet.owner.organizationId,
    publisherOrganizationId: publisherId,
    projectId,
    specVersionId: versionId,
    projectName: project?.name ?? "Unavailable API",
    projectSlug: project?.slug ?? "unavailable",
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
    credits: 0,
    billingOutcome: "exception",
    qualityOutcome: event.qualityOutcome,
    ambiguous: event.ambiguous,
    keyId: event.keyId,
    keyFamilyId: event.keyFamilyId,
    ownerUserId: event.ownerUserId,
    fundingSlices: [],
    exceptionCaseId: caseId,
  });
  await ctx.db.patch(wallet._id, {
    settledThroughEdgeSequence: event.edgeSequence,
  });
  return { refId: event.settleRefId, status: "exception" };
}

/** Internal operator recovery only. Pins the exact failed final and current
 * watermark; requires authentic admission, never guesses an upstream outcome.
 * The resulting canonical exception ACK is returned by ordinary ingest retries. */
export async function recoverRejectedFinal(
  ctx: MutationCtx,
  args: {
    eventJson: string;
    expectedFingerprint: string;
    expectedWatermark: number;
    reason: string;
  },
): Promise<Outcome> {
  if (
    args.eventJson.length > 1_048_576 ||
    args.reason.trim().length < 8 ||
    args.reason.length > 512
  )
    throw new ConvexError("Invalid recovery evidence");
  const event = settlement.parse(JSON.parse(args.eventJson));
  const digest = await fingerprint(facts(event));
  if (digest !== args.expectedFingerprint)
    throw new ConvexError("Recovery evidence changed");
  const ring = process.env.NEXT_ADMISSION_KEYS
    ? readRing(process.env.NEXT_ADMISSION_KEYS)
    : null;
  const secret = ring
    ? event.admissionKeyId && Object.hasOwn(ring.keys, event.admissionKeyId)
      ? ring.keys[event.admissionKeyId]
      : undefined
    : process.env.NEXT_ADMISSION_SECRET;
  if (
    !secret ||
    event.deploymentId !== process.env.NEXT_DEPLOYMENT_ID ||
    !(await verifyAdmission(event, secret))
  )
    throw new ConvexError("Admission evidence rejected");
  const prior = await ctx.db
    .query("usageEvents")
    .withIndex("by_ref", (q) => q.eq("settleRefId", event.settleRefId))
    .unique();
  if (prior) {
    if (prior.immutableFingerprint !== digest)
      throw new ConvexError("Recovery evidence changed");
    return {
      refId: event.settleRefId,
      status:
        prior.billingOutcome === "exception" ? "exception" : "already_applied",
    };
  }
  const wallet = await getWallet(ctx, id(ctx, "wallets", event.walletId));
  if (
    wallet.ownerKey !== event.ownerKey ||
    wallet.owner.clerkOrgId !== event.consumerClerkOrgId ||
    wallet.epoch !== event.epoch ||
    wallet.settledThroughEdgeSequence !== args.expectedWatermark ||
    event.edgeSequence !== args.expectedWatermark + 1
  )
    throw new ConvexError("Recovery wallet or watermark changed");
  return recordException(
    ctx,
    event,
    wallet,
    digest,
    Date.now(),
    `Operator recovery: ${args.reason}`,
  );
}
