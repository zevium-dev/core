import { format as formatDateFns } from "date-fns";

export const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FormatDateOptions {
  /** Show only date without time */
  dateOnly?: boolean;
  /** Force "time ago" format even for future dates */
  forceAgo?: boolean;
  /** Custom format string (overrides other options) */
  format?: string;
  /** Show only month and day */
  monthOnly?: boolean;
  /** Show time relative to now (e.g., "2 hours ago", "in 3 days") */
  relative?: boolean;
  /** Smart formatting: relative for recent dates (< 7 days), absolute otherwise */
  smart?: boolean;
}

export const formatDate = (date: Date | number | string, options: FormatDateOptions = {}): string => {
  const d = new Date(date);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const isFuture = diffMs > 0;
  const absDiffMs = Math.abs(diffMs);
  const absSeconds = Math.floor(absDiffMs / 1000);
  const absMinutes = Math.floor(absDiffMs / (1000 * 60));
  const absHours = Math.floor(absDiffMs / (1000 * 60 * 60));
  const absDays = Math.floor(absDiffMs / (1000 * 60 * 60 * 24));
  const absMonths = Math.floor(absDays / 30);

  const isRecent = absDays < 7;

  // Custom format
  if (options.format) {
    if (options.format === "dateOnly") {
      return formatDateFns(d, "MMM dd, yyyy");
    }
    if (options.format === "monthOnly") {
      return formatDateFns(d, "MMM dd");
    }
    return formatDateFns(d, options.format);
  }

  // Relative time formatting
  if (options.relative || (options.smart && isRecent)) {
    const useAgo = options.forceAgo ?? !isFuture;

    // Time in future
    if (!useAgo) {
      if (absSeconds < 60) return "in a few seconds";
      if (absMinutes < 60) return `in ${absMinutes}m`;
      if (absHours < 24) return `in ${absHours}h`;
      if (absDays < 30) return `in ${absDays}d`;
      return `in ${absMonths}mo`;
    }

    // Time in past (or forced ago)
    if (absSeconds < 60) return "just now";
    if (absMinutes < 60) return `${absMinutes}m ago`;
    if (absHours < 24) return `${absHours}h ago`;
    if (absDays < 30) return `${absDays}d ago`;
    return `${absMonths}mo ago`;
  }

  // Date only formatting
  if (options.dateOnly) {
    return formatDateFns(d, "MMMM d, yyyy");
  }

  // Month only formatting
  if (options.monthOnly) {
    return formatDateFns(d, "MMM d");
  }

  if (options.smart) {
    return formatDateFns(d, "MMM d, yyyy");
  }

  // Default formatting (also used for non-recent smart)
  return formatDateFns(d, "MMM d, yyyy, h:mm a");
};
