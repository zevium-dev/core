import type { Doc } from "../_generated/dataModel";

export function terminalDisputeStatus(
  status: Doc<"paymentDisputes">["status"],
): boolean {
  return (
    status === "warning_closed" ||
    status === "won" ||
    status === "lost" ||
    status === "prevented"
  );
}

export function paymentStatusForProjection(args: {
  grantedCredits: number;
  refundedCredits: number;
  disputes: Doc<"paymentDisputes">[];
}): Doc<"payments">["status"] {
  const moneyOutstanding = args.disputes.filter(
    (dispute) => dispute.fundsWithdrawn && !dispute.fundsReinstated,
  );
  const open = args.disputes.some(
    (dispute) => !terminalDisputeStatus(dispute.status),
  );
  if (open || moneyOutstanding.some((dispute) => dispute.status !== "lost")) {
    return "disputed";
  }
  if (moneyOutstanding.length > 0) return "dispute_lost";
  if (args.refundedCredits === args.grantedCredits) return "refunded";
  if (args.refundedCredits > 0) return "partially_refunded";
  if (args.disputes.some((dispute) => dispute.status === "lost")) {
    return "dispute_lost";
  }
  if (
    args.disputes.some(
      (dispute) => dispute.status === "won" || dispute.status === "prevented",
    )
  ) {
    return "dispute_won";
  }
  return "paid";
}
