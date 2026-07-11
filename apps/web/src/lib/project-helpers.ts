/** 10,000 credits = $1 (publisher-facing display conversion). */
export const CREDITS_PER_DOLLAR = 10_000;

/** Publisher keeps 95% of gross credits after platform cut. */
export const PUBLISHER_SHARE = 0.95;

/** Convert credits to USD dollars (fractional). */
export function creditsToDollars(credits: number): number {
  if (!Number.isFinite(credits)) return 0;
  return credits / CREDITS_PER_DOLLAR;
}

/**
 * Format credits as a USD string, e.g. "$1.25" / "$0.00".
 * Uses up to 4 decimal places for small amounts, trims trailing zeros.
 */
export function formatCreditsAsUsd(credits: number): string {
  const dollars = creditsToDollars(credits);
  if (!Number.isFinite(dollars)) return "$0.00";

  const abs = Math.abs(dollars);
  // Whole dollars or ≥1 cent: 2dp. Sub-cent: up to 4dp so tiny nets aren't "$0.00".
  const fractionDigits = abs > 0 && abs < 0.01 ? 4 : 2;
  const fixed = dollars.toFixed(fractionDigits);
  // Trim trailing zeros past 2dp only when we used 4dp.
  const cleaned =
    fractionDigits === 4 ? fixed.replace(/(\.\d{2}\d*?)0+$/, "$1") : fixed;
  return `$${cleaned}`;
}

/**
 * Parse a free-text tag field (comma / whitespace separated) into
 * lowercase unique tags. Mirrors server normalization in projects.update.
 */
export function parseTagsInput(input: string): string[] {
  const raw = input
    .split(/[,\n]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of raw) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
  }
  return unique;
}
