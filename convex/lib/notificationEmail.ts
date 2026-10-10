import { Resend } from "@convex-dev/resend";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

// Construct at call time so missing credentials never fail module evaluation.
export function notificationMailer(): Resend {
  return new Resend(components.resend, { testMode: false });
}

const destinations: Record<Doc<"notifications">["kind"], string> = {
  low_balance: "/app/billing",
  spec_published: "/app",
  version_deprecated: "/app",
  project_retirement: "/app",
  webhook_failed: "/app",
  visibility_changed: "/app",
  transfer_failed: "/app/earnings",
  transfer_sent: "/app/earnings",
  quality_suspended: "/app",
  quality_restored: "/app",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Plain event facts, no remote assets or publisher-supplied HTML/URLs. */
export function notificationTemplate(
  notification: Doc<"notifications">,
  organizationName: string,
) {
  const origin = new URL(process.env.APP_ORIGIN ?? "https://www.zevium.dev");
  if (
    origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  ) {
    throw new Error("Email app origin must use HTTPS");
  }
  const destination =
    notification.publisherHandle && notification.projectSlug
      ? `/catalogue/${encodeURIComponent(notification.publisherHandle)}/${encodeURIComponent(notification.projectSlug)}`
      : destinations[notification.kind];
  const url = new URL(destination, origin.origin).href;
  const context = `Notification for ${organizationName}. Select this organization in Zevium to view its details.`;
  return {
    subject: notification.title.replace(/[\r\n]/g, " ").slice(0, 200),
    text: `${notification.title}\n\n${notification.body}\n\n${context}\n${url}`,
    html: `<h1>${escapeHtml(notification.title)}</h1><p>${escapeHtml(notification.body).replaceAll("\n", "<br>")}</p><p>${escapeHtml(context)}</p><p><a href="${escapeHtml(url)}">View in Zevium</a></p>`,
  };
}
