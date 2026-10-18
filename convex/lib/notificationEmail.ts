import { Resend } from "@convex-dev/resend";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { configuredAppOrigin } from "./appOrigin";

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

/**
 * Sender, key and link origin all configured, or null. A missing/invalid
 * APP_ORIGIN skips email (logged) instead of linking to a guessed site.
 */
export function emailConfig(): { from: string; appOrigin: string } | null {
  const from = process.env.EMAIL_FROM?.trim();
  if (!from || !process.env.RESEND_API_KEY?.trim()) return null;
  const appOrigin = configuredAppOrigin("APP_ORIGIN");
  return appOrigin ? { from, appOrigin } : null;
}

/** Plain event facts, no remote assets or publisher-supplied HTML/URLs. */
export function notificationTemplate(
  notification: Doc<"notifications">,
  organizationName: string,
  appOrigin: string,
) {
  const destination =
    notification.publisherHandle && notification.projectSlug
      ? `/catalogue/${encodeURIComponent(notification.publisherHandle)}/${encodeURIComponent(notification.projectSlug)}`
      : (destinations[notification.kind] ?? "/app");
  const url = new URL(destination, appOrigin).href;
  const context = `Notification for ${organizationName}. Select this organization in Zevium to view its details.`;
  const plain = (value: string) => value.replace(/([.:@/])/g, "$1\u200b");
  const title = plain(notification.title),
    body = plain(notification.body);
  return {
    subject: notification.title.replace(/[\r\n]/g, " ").slice(0, 200),
    text: `${title}\n\n${body}\n\n${context}\n${url}`,
    html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body).replaceAll("\n", "<br>")}</p><p>${escapeHtml(context)}</p><p><a href="${escapeHtml(url)}">View in Zevium</a></p>`,
  };
}
