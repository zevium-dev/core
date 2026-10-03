/** Map unknown mutation/query errors to short human copy. Never leak internals. */
export function humanError(
  err: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (err instanceof Error) {
    const msg = err.message.trim();
    const publicFinanceErrors: Record<string, string> = {
      CONNECT_ACCOUNT_RECONCILIATION_REQUIRED:
        "Support needs to check your Stripe account before onboarding can continue.",
      CONNECT_PROVIDER_REJECTED:
        "Stripe rejected onboarding details. Check country and contact details, then try again.",
      TRANSFER_PROVIDER_REJECTED:
        "Stripe rejected this transfer without sending funds. Check your connected account details and try again.",
      TRANSFER_REQUIRES_RECONCILIATION:
        "This transfer needs a status check with Stripe. Contact support before retrying to avoid sending funds twice.",
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
