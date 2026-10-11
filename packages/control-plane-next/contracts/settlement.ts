import { z } from "zod";
import { digest, fundingSlices, identity, integer } from "./money";

// Admission fields are immutable evidence; final outcome is fingerprinted separately.
export const admission = z.strictObject({
  protocolVersion: z.literal(2),
  deploymentId: identity,
  walletId: identity,
  ownerKey: identity,
  consumerClerkOrgId: identity,
  publisherOrganizationId: identity,
  projectId: identity,
  specVersionId: identity,
  specVersion: identity,
  specDigest: digest,
  operationId: identity,
  endpoint: identity,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  reservationId: identity,
  settleRefId: identity,
  epoch: integer,
  edgeSequence: integer.positive(),
  admittedAt: integer,
  heldCredits: integer,
  fundingSlices,
  listedCostCredits: integer,
  pricingDecision: z.enum(["listed_price", "zero_price", "free_tier"]),
  keyId: identity,
  keyFamilyId: identity,
  ownerUserId: identity,
  budgetPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  budgetUsedBefore: integer,
  budgetReservedBefore: integer,
  monthlyCapCredits: integer.optional(),
  freeTierLimit: integer.optional(),
  freeTierUsedBefore: integer.optional(),
  publisherIdempotencyKey: identity.optional(),
});
function validateAdmission(a: z.infer<typeof admission>, ctx: z.RefinementCtx) {
  if (
    a.ownerKey !== `org:${a.consumerClerkOrgId}` ||
    a.settleRefId !== `settle:${a.reservationId}`
  )
    ctx.addIssue({ code: "custom", message: "Admission identity mismatch" });
  if (a.fundingSlices.reduce((n, s) => n + s.credits, 0) !== a.heldCredits)
    ctx.addIssue({ code: "custom", message: "Slices must back entire hold" });
  const cost = a.pricingDecision === "listed_price" ? a.listedCostCredits : 0;
  if (
    cost !== a.heldCredits ||
    (a.pricingDecision === "listed_price" && cost === 0) ||
    (a.pricingDecision === "zero_price" && a.listedCostCredits !== 0)
  )
    ctx.addIssue({
      code: "custom",
      message: "Only scalar fixed-price holds are accepted",
    });
  if (
    a.pricingDecision === "free_tier" &&
    (a.freeTierLimit === undefined ||
      a.freeTierUsedBefore === undefined ||
      a.freeTierUsedBefore >= a.freeTierLimit)
  )
    ctx.addIssue({
      code: "custom",
      message: "Free tier requires remaining allowance",
    });
  const reserved = a.budgetUsedBefore + a.budgetReservedBefore + a.heldCredits;
  if (
    !Number.isSafeInteger(reserved) ||
    (a.monthlyCapCredits !== undefined && reserved > a.monthlyCapCredits)
  )
    ctx.addIssue({ code: "custom", message: "Admission exceeds budget" });
}
export const admittedRequest = admission.superRefine(validateAdmission);
export const settlement = admission
  .extend({
    admissionFingerprint: digest,
    credits: integer,
    status: integer.min(100).max(599),
    latencyMs: integer,
    at: integer,
    billingOutcome: z.enum(["settled", "refunded", "free"]),
    qualityOutcome: z.enum([
      "success",
      "client_error",
      "server_error",
      "network_error",
    ]),
    ambiguous: z.boolean(),
  })
  .superRefine((s, ctx) => {
    validateAdmission(s, ctx);
    const statusValid =
      (s.qualityOutcome === "success" && s.status >= 200 && s.status < 300) ||
      (s.qualityOutcome === "client_error" &&
        s.status >= 400 &&
        s.status < 500) ||
      (s.qualityOutcome === "server_error" &&
        s.status >= 500 &&
        s.status < 600) ||
      (s.qualityOutcome === "network_error" &&
        ((s.status >= 300 && s.status < 400) || s.status === 502));
    if (
      !statusValid ||
      (s.billingOutcome === "refunded") === (s.qualityOutcome === "success")
    )
      ctx.addIssue({
        code: "custom",
        message: "Billing, quality and HTTP outcomes disagree",
      });

    if (s.at < s.admittedAt)
      ctx.addIssue({
        code: "custom",
        message: "Finalization precedes admission",
      });
    if (
      s.credits !== (s.billingOutcome === "settled" ? s.heldCredits : 0) ||
      (s.billingOutcome === "free" && s.heldCredits !== 0) ||
      (s.billingOutcome === "settled" && s.heldCredits === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Finalization must settle fixed hold or refund it",
      });
  });
export const ingestUsage = z
  .strictObject({ events: z.array(settlement).min(1).max(100) })
  .superRefine(({ events }, ctx) => {
    if (
      new Set(
        events.map((e) =>
          JSON.stringify([
            e.walletId,
            e.ownerKey,
            e.consumerClerkOrgId,
            e.deploymentId,
          ]),
        ),
      ).size !== 1 ||
      new Set(events.map((e) => e.settleRefId)).size !== events.length ||
      new Set(events.map((e) => `${e.epoch}:${e.edgeSequence}`)).size !==
        events.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Batch requires one wallet and unique finalization refs/sequences",
      });
  });
export const settlementOutcome = z.union([
  z.strictObject({
    refId: identity,
    status: z.enum(["applied", "already_applied", "exception"]),
  }),
  z.strictObject({
    refId: identity,
    status: z.literal("rejected"),
    reason: identity,
    retryable: z.boolean(),
  }),
]);
export type Admission = z.infer<typeof admittedRequest>;
export type Settlement = z.infer<typeof settlement>;
