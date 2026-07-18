import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "#/components/ui/badge";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export type CheckoutState = "processing" | "succeeded" | "failed";

export type CheckoutDisplay = {
  title: string;
  description: string;
  variant: BadgeVariant;
};

/**
 * The redirect from hosted Checkout is only a status view. Credit fulfillment
 * remains exclusively webhook-driven on the server.
 */
export function checkoutDisplay(state: CheckoutState): CheckoutDisplay {
  switch (state) {
    case "succeeded":
      return {
        title: "Payment confirmed",
        description:
          "Your credited balance updates after the payment ledger is fulfilled.",
        variant: "secondary",
      };
    case "failed":
      return {
        title: "Payment was not completed",
        description: "No credits were added. Choose a pack to try again.",
        variant: "destructive",
      };
    case "processing":
      return {
        title: "Confirming payment",
        description:
          "We are waiting for Stripe to confirm this payment. Credits are not added from this page.",
        variant: "outline",
      };
  }
}

export function checkoutStateFromStatus(status: string): CheckoutState {
  switch (status) {
    case "succeeded":
    case "paid":
    case "completed":
      return "succeeded";
    case "failed":
    case "payment_failed":
    case "expired":
    case "canceled":
    case "cancelled":
      return "failed";
    default:
      return "processing";
  }
}

export function checkoutPackButton(
  packId: string,
  selectedPackId: string | null,
  isPending: boolean,
  priceLabel: string,
): { disabled: boolean; label: string } {
  return {
    disabled: isPending,
    label:
      isPending && selectedPackId === packId
        ? "Redirecting to Stripe…"
        : `Buy ${priceLabel}`,
  };
}

export function checkoutStartFailureMessage(message?: string): string {
  return message?.trim() || "Could not start secure checkout.";
}

export type PaymentStatus =
  "pending" | "succeeded" | "failed" | "refunded" | "disputed";

export function paymentStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Processing";
    case "succeeded":
    case "paid":
      return "Paid";
    case "failed":
    case "payment_failed":
    case "expired":
      return "Failed";
    case "refunded":
      return "Refunded";
    case "disputed":
      return "Disputed";
    default:
      return "Processing";
  }
}

export function paymentStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "succeeded":
    case "paid":
      return "secondary";
    case "failed":
    case "payment_failed":
    case "expired":
    case "disputed":
      return "destructive";
    case "pending":
    case "refunded":
      return "outline";
    default:
      return "outline";
  }
}

export type ConnectedAccountStatus =
  "not_started" | "incomplete" | "restricted" | "enabled";

export type ConnectedAccountDisplay = {
  title: string;
  description: string;
  action: "start" | "continue" | "fix" | null;
  actionLabel: string | null;
  variant: BadgeVariant;
};

export function connectedAccountDisplay(
  status: ConnectedAccountStatus,
  disabledReason?: string,
  requirements: readonly string[] = [],
): ConnectedAccountDisplay {
  const requirementSummary = requirements.length
    ? ` Stripe still needs: ${requirements.join(", ")}.`
    : "";

  switch (status) {
    case "not_started":
      return {
        title: "Connect account not started",
        description:
          "Complete Stripe Connect onboarding before you can receive transfers.",
        action: "start",
        actionLabel: "Start Stripe onboarding",
        variant: "outline",
      };
    case "incomplete":
      return {
        title: "More information needed",
        description: `Continue onboarding in Stripe before payouts can be enabled.${requirementSummary}`,
        action: "continue",
        actionLabel: "Continue onboarding",
        variant: "outline",
      };
    case "restricted":
      return {
        title: "Connect account restricted",
        description: `${disabledReason ?? "Stripe requires changes before transfers can resume."}${requirementSummary}`,
        action: "fix",
        actionLabel: "Fix in Stripe",
        variant: "destructive",
      };
    case "enabled":
      return {
        title: "Connect account enabled",
        description:
          "Stripe can receive transfers and manage bank payouts for this organization.",
        action: null,
        actionLabel: null,
        variant: "secondary",
      };
  }
}

export type EarningStatus =
  | "pending_risk"
  | "available"
  | "allocated_to_transfer"
  | "transferred"
  | "paid"
  | "reversed"
  | "failed";

export function earningStatusLabel(status: EarningStatus): string {
  switch (status) {
    case "pending_risk":
      return "Pending risk review";
    case "available":
      return "Available";
    case "allocated_to_transfer":
      return "Transfer in progress";
    case "transferred":
      return "Transferred to Stripe";
    case "paid":
      return "Paid to bank";
    case "reversed":
      return "Reversed";
    case "failed":
      return "Transfer failed";
  }
}

export function earningStatusVariant(status: EarningStatus): BadgeVariant {
  switch (status) {
    case "paid":
    case "transferred":
      return "secondary";
    case "reversed":
    case "failed":
      return "destructive";
    case "pending_risk":
    case "available":
    case "allocated_to_transfer":
      return "outline";
  }
}

export type EarningTotals = {
  pending: number;
  available: number;
  transferred: number;
  paid: number;
  reversed: number;
};

export function earningTotalsByStatus(
  earnings: readonly { status: EarningStatus; netCredits: number }[],
): EarningTotals {
  const totals: EarningTotals = {
    pending: 0,
    available: 0,
    transferred: 0,
    paid: 0,
    reversed: 0,
  };

  for (const earning of earnings) {
    switch (earning.status) {
      case "pending_risk":
      case "allocated_to_transfer":
      case "failed":
        totals.pending += earning.netCredits;
        break;
      case "available":
        totals.available += earning.netCredits;
        break;
      case "transferred":
        totals.transferred += earning.netCredits;
        break;
      case "paid":
        totals.paid += earning.netCredits;
        break;
      case "reversed":
        totals.reversed += earning.netCredits;
        break;
    }
  }

  return totals;
}

export type MoneyMovementStatus =
  "pending" | "processing" | "succeeded" | "failed" | "reversed" | "paid";

export function moneyMovementStatusLabel(status: string): string {
  switch (status) {
    case "created":
      return "Created";
    case "pending":
    case "queued":
      return "Queued";
    case "processing":
    case "in_transit":
      return "Processing";
    case "succeeded":
    case "transferred":
      return "Transferred";
    case "paid":
      return "Paid";
    case "failed":
      return "Failed";
    case "reversed":
      return "Reversed";
    case "canceled":
      return "Canceled";
    default:
      return "Processing";
  }
}

export function moneyMovementStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "succeeded":
    case "transferred":
    case "paid":
      return "secondary";
    case "failed":
    case "reversed":
    case "canceled":
      return "destructive";
    default:
      return "outline";
  }
}

export function moneyMovementFailure(
  status: string,
  failureReason?: string,
): string | null {
  if (status !== "failed") return null;
  return (
    failureReason ??
    "Stripe could not complete this movement. It can be retried safely."
  );
}

export function operatorTransferAction(status: string): {
  action: "retry" | null;
  label: string | null;
  confirmation: string | null;
} {
  if (status !== "failed") {
    return { action: null, label: null, confirmation: null };
  }
  return {
    action: "retry",
    label: "Retry transfer",
    confirmation:
      "Retry this failed Stripe transfer? The server will reuse its idempotency key.",
  };
}
