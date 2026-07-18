/**
 * Compact relative-time formatter for notification feeds.
 *
 * Pure + deterministic for a fixed `now`, so it is unit-testable without timers.
 * Buckets mirror what a glance should convey: "just now" → minutes → hours →
 * days → weeks → absolute date. Designed for list density, not precision.
 *
 * @param then epoch-ms of the event
 * @param now  epoch-ms reference (defaults to Date.now())
 */
export function formatRelativeTime(
  then: number,
  now: number = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));

  if (seconds < 45) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;

  // Beyond ~5 weeks the relative bucket loses meaning — show a real date.
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
