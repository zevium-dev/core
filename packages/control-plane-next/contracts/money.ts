import { z } from "zod";

export const MAX_FUNDING_SLICES = 32;
export const EXECUTABLE_AUTHORITY_MS = 30_000;
export const CATALOGUE_AUTHORITY_MS = 60_000;
export const SIGNUP_GRANT_CREDITS = 10_000;
// Initial configurable proposal from the plan, not an immutable product policy.
export const DEFAULT_DUST_THRESHOLD_CREDITS = 1_000;
export const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const signedInteger = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const identity = z.string().min(1).max(512);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const owner = z.strictObject({
  kind: z.literal("org"),
  organizationId: identity,
  clerkOrgId: identity,
});
export const fundingSlice = z.strictObject({
  lotId: identity,
  originLotId: identity,
  sourceRef: identity,
  paymentId: identity.optional(),
  credits: integer.positive(),
});
export const fundingSlices = z
  .array(fundingSlice)
  .max(MAX_FUNDING_SLICES)
  .superRefine((slices, ctx) => {
    const keys = slices.map((s) => JSON.stringify([s.lotId, s.originLotId]));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate original source in container",
      });
    if (!Number.isSafeInteger(slices.reduce((sum, s) => sum + s.credits, 0)))
      ctx.addIssue({
        code: "custom",
        message: "Funding total exceeds safe integer range",
      });
  });
export const lotCompatibility = z.strictObject({
  walletId: identity,
  expiryClass: identity,
  expiresAt: integer.optional(),
  sourceKind: z.enum(["payment", "promo", "admin"]),
  refundable: z.boolean(),
  priority: integer,
});
export function compatibleLots(
  a: z.infer<typeof lotCompatibility>,
  b: z.infer<typeof lotCompatibility>,
): boolean {
  return (
    a.walletId === b.walletId &&
    a.expiryClass === b.expiryClass &&
    a.expiresAt === b.expiresAt &&
    a.sourceKind === b.sourceKind &&
    a.refundable === b.refundable &&
    a.priority === b.priority
  );
}
export const lotMove = z
  .strictObject({
    walletId: identity,
    refId: identity,
    kind: z.literal("lot_move"),
    amount: z.literal(0),
    balanceAfter: integer,
    sequence: integer.positive(),
    fromLotId: identity,
    toLotId: identity,
    originLotId: identity,
    sourceRef: identity,
    paymentId: identity.optional(),
    movedCredits: integer.positive(),
    reason: z.literal("dust_merge"),
    mergeId: identity,
  })
  .refine((m) => m.fromLotId !== m.toLotId, "Move must change container");
export const signupGrant = z
  .strictObject({
    clerkUserId: identity,
    personalOrganizationId: identity,
    personalForClerkUserId: identity,
    refId: identity,
    credits: z.literal(SIGNUP_GRANT_CREDITS),
  })
  .refine(
    (g) =>
      g.clerkUserId === g.personalForClerkUserId &&
      g.refId === `signup:${g.clerkUserId}`,
    "Grant must bind signup user and personal organization",
  );
export const feeFacts = z
  .strictObject({
    creditFaceValueCents: integer,
    processingFeeChargedCents: integer,
    processingFeeActualCents: integer.optional(),
    processingFeeVarianceCents: signedInteger.optional(),
    amountPaidCents: integer,
    credits: integer,
    feePolicyVersion: identity,
    refundFeePolicy: z.literal("full_paid_amount"),
  })
  .superRefine((f, ctx) => {
    if (
      f.amountPaidCents !==
        f.creditFaceValueCents + f.processingFeeChargedCents ||
      f.credits !== f.creditFaceValueCents * 100
    )
      ctx.addIssue({
        code: "custom",
        message: "Fee cannot mint principal credits",
      });
    if (
      (f.processingFeeActualCents === undefined) !==
        (f.processingFeeVarianceCents === undefined) ||
      (f.processingFeeActualCents !== undefined &&
        f.processingFeeVarianceCents !==
          f.processingFeeActualCents - f.processingFeeChargedCents)
    )
      ctx.addIssue({
        code: "custom",
        message: "Variance is actual minus charged; Zevium absorbs it",
      });
  });
export const refundFacts = z
  .strictObject({
    amountPaidCents: integer,
    creditFaceValueCents: integer,
    processingFeeChargedCents: integer,
    priorPrincipalCents: integer,
    priorFeeCents: integer,
    principalCents: integer,
    feeCents: integer,
    full: z.boolean(),
  })
  .refine(
    (f) =>
      f.amountPaidCents ===
        f.creditFaceValueCents + f.processingFeeChargedCents &&
      f.priorPrincipalCents + f.principalCents <= f.creditFaceValueCents &&
      f.priorFeeCents + f.feeCents <= f.processingFeeChargedCents &&
      (!f.full ||
        f.priorPrincipalCents +
          f.principalCents +
          f.priorFeeCents +
          f.feeCents ===
          f.amountPaidCents),
    "Refund must conserve principal and fee, including every remaining cent on full refund",
  );
