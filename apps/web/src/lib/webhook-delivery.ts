/**
 * Pure mapping from a webhook delivery row to its badge presentation.
 *
 * Webhook delivery status is one of "ok" | "failed" | "pending" (see
 * `convex/schema.ts`). We never reach for raw Tailwind colors — each status
 * layers semantic-token utilities (`success` / `warning` / `destructive`)
 * onto a stock outline Badge, so dark+light stay first-class.
 */

export type WebhookDeliveryStatus = "ok" | "failed" | "pending";

export type DeliveryStatusView = {
  /** Label shown to users. */
  label: string;
  /** Stock Badge variant to start from. */
  badgeVariant: "outline" | "destructive";
  /** Semantic-token overlay appended to the Badge (keeps tokens, no raw colors). */
  className: string;
  /** Small status dot color. */
  dotClassName: string;
};

const VIEWS: Record<WebhookDeliveryStatus, DeliveryStatusView> = {
  ok: {
    label: "Delivered",
    badgeVariant: "outline",
    className: "border-success/40 bg-success/10 text-success-foreground",
    dotClassName: "bg-success",
  },
  failed: {
    label: "Failed",
    badgeVariant: "destructive",
    className: "",
    // Solid red badge already signals failure — no dot needed.
    dotClassName: "",
  },
  pending: {
    label: "Pending",
    badgeVariant: "outline",
    className: "border-warning/40 bg-warning/10 text-warning-foreground",
    dotClassName: "bg-warning",
  },
};

export function deliveryStatusView(
  status: WebhookDeliveryStatus,
): DeliveryStatusView {
  return VIEWS[status];
}

/**
 * Truncate a delivery `lastError` for dense list display.
 * Returns "" when there is nothing to show.
 */
export function truncateError(error: string | undefined, max = 80): string {
  if (error === undefined || error.length === 0) return "";
  const trimmed = error.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}
