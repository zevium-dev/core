/** Map unknown mutation/query errors to short human copy. Never leak internals. */
export function humanError(
  err: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (err instanceof Error) {
    const msg = err.message.trim();
    const publicFinanceErrors: Record<string, string> = {
      CONNECT_ACCOUNT_RECONCILIATION_REQUIRED:
        "Stripe onboarding needs operator reconciliation before it can continue.",
      CONNECT_PROVIDER_REJECTED:
        "Stripe rejected onboarding details. Check country and contact details, then try again.",
      TRANSFER_PROVIDER_REJECTED:
        "Stripe rejected this payout without sending funds. Correct payout details and try again.",
      TRANSFER_REQUIRES_RECONCILIATION:
        "This payout needs Stripe reconciliation. Do not retry it; support will resolve it safely.",
    };
    if (publicFinanceErrors[msg] !== undefined) return publicFinanceErrors[msg];
    if (msg === "Forbidden" || msg === "Unauthorized") {
      return "You do not have access to this action. Check your organization role and try again.";
    }
    if (
      msg.length > 0 &&
      msg.length <= 200 &&
      !msg.includes("Server Error") &&
      !msg.includes("ConvexError") &&
      !msg.startsWith("Uncaught") &&
      !msg.includes("at handler")
    ) {
      return msg;
    }
  }
  if (typeof err === "string" && err.trim().length > 0 && err.length <= 200) {
    return err.trim();
  }
  return fallback;
}
