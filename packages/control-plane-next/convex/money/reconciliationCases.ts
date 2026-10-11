import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { add } from "./walletLedger";
type Case = Extract<Doc<"financeReconciliationCases">, { rowKind: "case" }>;
export async function openCase(
  ctx: MutationCtx,
  input: Pick<Case, "kind" | "reason" | "operationId"> &
    Partial<Pick<Case, "organizationId" | "transferId" | "paymentId">>,
  evidence?: string,
) {
  const prior = await ctx.db
    .query("financeReconciliationCases")
    .withIndex("by_operation", (q) =>
      q.eq("rowKind", "case").eq("operationId", input.operationId),
    )
    .unique();
  const id = prior
    ? prior._id
    : await ctx.db.insert("financeReconciliationCases", {
        ...input,
        rowKind: "case",
        status: "open",
        candidateCount: 0,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  if (evidence) await caseEvidence(ctx, id, "candidate", evidence);
  return id;
}
export async function caseEvidence(
  ctx: MutationCtx,
  caseId: Id<"financeReconciliationCases">,
  rowKind: "candidate" | "provider_request",
  value: string,
) {
  if (value.length > 4096) throw new Error("Evidence exceeds bound");
  const parent = await ctx.db.get(caseId);
  if (!parent || parent.rowKind !== "case") throw new Error("Case not found");
  const prior = await ctx.db
    .query("financeReconciliationCases")
    .withIndex("by_case_evidence", (q) =>
      q.eq("caseId", caseId).eq("rowKind", rowKind).eq("value", value),
    )
    .unique();
  if (!prior) {
    await ctx.db.insert("financeReconciliationCases", {
      caseId,
      rowKind,
      value,
      createdAt: Date.now(),
    });
    if (rowKind === "candidate")
      await ctx.db.patch(caseId, {
        candidateCount: add(parent.candidateCount, 1),
        updatedAt: Date.now(),
      });
  }
}

export async function holdPublisher(
  ctx: MutationCtx,
  paymentId: Id<"payments">,
  organizationId: Id<"organizations">,
) {
  const id = await openCase(ctx, {
    kind: "publisher_hold",
    paymentId,
    organizationId,
    operationId: `payment-hold:${paymentId}:${organizationId}`,
    reason: "Payment source reconciliation in progress",
  });
  await ctx.db.patch(id, { status: "open", updatedAt: Date.now() });
}
