export type SettlementIdentityV2 = {
  consumerClerkOrgId: string;
  consumerOrganizationId: string;
  publisherOrganizationId: string;
  projectId: string;
  specVersionId: string;
  specVersion: string;
  operationId: string;
  endpoint: string;
  method: string;
  listedCostCredits: number;
  freeTierLimit?: number;
  freeTierUsedBefore?: number;
  pricingDecision: "listed_price" | "free_tier" | "zero_price";
  credits: number;
  status: number;
  latencyMs: number;
  keyId: string;
  keyFamilyId: string;
  monthlyCapCredits?: number;
  budgetPeriod: string;
  budgetUsedBefore: number;
  budgetReservedBefore: number;
  budgetReservationCredits: number;
  at: number;
  reservationId: string;
  settleRefId: string;
  ambiguous?: boolean;
  publisherIdempotencyKey?: string;
};

export async function settlementIdentityFingerprint(
  identity: SettlementIdentityV2,
): Promise<string> {
  const canonical = JSON.stringify([
    2,
    identity.consumerClerkOrgId,
    identity.consumerOrganizationId,
    identity.publisherOrganizationId,
    identity.projectId,
    identity.specVersionId,
    identity.specVersion,
    identity.operationId,
    identity.endpoint,
    identity.method,
    identity.listedCostCredits,
    identity.freeTierLimit ?? null,
    identity.freeTierUsedBefore ?? null,
    identity.pricingDecision,
    identity.credits,
    identity.status,
    identity.latencyMs,
    identity.keyId,
    identity.keyFamilyId,
    identity.monthlyCapCredits ?? null,
    identity.budgetPeriod,
    identity.budgetUsedBefore,
    identity.budgetReservedBefore,
    identity.budgetReservationCredits,
    identity.at,
    identity.reservationId,
    identity.settleRefId,
    identity.ambiguous ?? false,
    identity.publisherIdempotencyKey ?? null,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
