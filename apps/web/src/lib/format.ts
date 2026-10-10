/** Locale and timezone are explicit so server and browser render identical text. */
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const publisherCredits = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const date = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});
const timestamp = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});
const cycleMonth = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatCredits(value: number): string {
  return integer.format(Number.isFinite(value) ? Math.trunc(value) : 0);
}

/** Decimal credits converted from canonical accounting atoms by the server. */
export function formatPublisherCredits(value: number): string {
  return publisherCredits.format(Number.isFinite(value) ? value : 0);
}

export function formatNumber(value: number): string {
  return decimal.format(Number.isFinite(value) ? value : 0);
}

/** Stripe amounts are minor currency units; launch accounting is USD. */
export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

export function formatDate(value: number): string {
  return date.format(value);
}
export function formatDateTime(value: number): string {
  return dateTime.format(value);
}
export function formatTimestamp(value: number): string {
  return timestamp.format(value);
}
export function formatCycleMonthLabel(value: number): string {
  return Number.isFinite(value)
    ? `${cycleMonth.format(value)} (UTC)`
    : "Current cycle (UTC)";
}

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

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
  return shortDate.format(then);
}
