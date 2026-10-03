import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { publisherEarningSplit } from "../accounting";

/** Recognize the original persisted contract, never a partly populated v2 row.
 * Display labels added by migration are deliberately outside this identity. */
export function isLegacySettlement(usage: Doc<"usageEvents">): boolean {
  return [
    usage.settlementIdentityVersion,
    usage.publisherOrganizationId,
    usage.specVersionId,
    usage.specVersion,
    usage.operationId,
    usage.listedCostCredits,
    usage.freeTierLimit,
    usage.freeTierUsedBefore,
    usage.pricingDecision,
    usage.keyFamilyId,
    usage.monthlyCapCredits,
    usage.budgetPeriod,
    usage.budgetUsedBefore,
    usage.budgetReservedBefore,
    usage.budgetReservationCredits,
    usage.reservationId,
    usage.ambiguous,
    usage.publisherIdempotencyKey,
    usage.gatewayRelease,
    usage.releaseChallenge,
  ].every((value) => value === undefined);
}

/** Verify the recorded debit and publisher split without claiming knowledge of
 * API versions, prices, reservations or budgets the old producer never stored. */
export async function legacySettlementFacts(
  ctx: MutationCtx | QueryCtx,
  usage: Doc<"usageEvents">,
  settleRefId: string,
) {
  const [project, consumer, wallet, entry, earning] = await Promise.all([
    ctx.db.get(usage.projectId),
    ctx.db.get(usage.organizationId),
    ctx.db
      .query("wallets")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", usage.organizationId),
      )
      .unique(),
    ctx.db
      .query("walletEntries")
      .withIndex("by_ref", (q) => q.eq("refId", settleRefId))
      .unique(),
    ctx.db
      .query("publisherEarnings")
      .withIndex("by_settlement", (q) =>
        q.eq("usageSettlementRefId", settleRefId),
      )
      .unique(),
  ]);
  if (
    !isLegacySettlement(usage) ||
    usage.settleRefId !== settleRefId ||
    !/^settle:.+/.test(settleRefId) ||
    !Number.isSafeInteger(usage.credits) ||
    usage.credits < 0 ||
    usage.keyId.trim() === "" ||
    usage.endpoint.trim() === "" ||
    usage.method.trim() === "" ||
    project === null ||
    consumer === null ||
    wallet === null ||
    entry === null ||
    earning === null ||
    entry.walletId !== wallet._id ||
    entry.kind !== "usage_settlement" ||
    entry.usageEventId !== usage._id ||
    entry.amount !== -usage.credits ||
    earning.projectId !== project._id ||
    earning.publisherOrganizationId !== project.organizationId ||
    earning.grossCredits !== usage.credits ||
    earning.specVersionId !== undefined ||
    (earning.consumerOrganizationId !== undefined &&
      earning.consumerOrganizationId !== usage.organizationId)
  ) {
    throw new Error(
      "Legacy settlement lacks exact recorded financial provenance",
    );
  }
  const publisher = await ctx.db.get(earning.publisherOrganizationId);
  const split = publisherEarningSplit(usage.credits);
  if (
    publisher === null ||
    earning.netCredits !== split.publisherNetCredits ||
    earning.platformFeeCredits !== split.platformFeeCredits ||
    (earning.publisherNetAtoms !== undefined &&
      earning.publisherNetAtoms !== split.publisherNetAtoms) ||
    (earning.platformFeeAtoms !== undefined &&
      earning.platformFeeAtoms !== split.platformFeeAtoms)
  ) {
    throw new Error(
      "Legacy settlement publisher split conflicts with recorded credits",
    );
  }
  const canonical = JSON.stringify([
    "legacy-finance-v1",
    usage._id,
    consumer._id,
    consumer.clerkOrgId,
    publisher._id,
    project._id,
    earning._id,
    usage.endpoint,
    usage.method,
    usage.credits,
    usage.status,
    usage.latencyMs,
    usage.keyId,
    usage.at,
    settleRefId,
    earning.platformFeeCredits,
    earning.netCredits,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  const fingerprint = `legacy-finance-v1:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (
    entry.settlementFingerprint !== undefined &&
    entry.settlementFingerprint !== fingerprint
  ) {
    throw new Error(
      "Legacy settlement fingerprint conflicts with recorded facts",
    );
  }
  return { project, consumer, publisher, wallet, entry, earning, fingerprint };
}
