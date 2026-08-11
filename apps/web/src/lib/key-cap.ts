/**
 * Pure parse/format helpers for the per-key monthly credit cap.
 *
 * Blank input means unlimited (null). A valid cap is a positive whole number.
 * Kept dependency-free so it unit-tests without Clerk/TanStack runtime.
 */

export type ParsedCap =
  { ok: true; cap: number | null } | { ok: false; error: string };

export const CAP_ERROR = "Cap must be a positive whole number of credits";

/** Parse user cap input. Blank → null (unlimited). */
export function parseMonthlyCap(input: string): ParsedCap {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, cap: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, error: CAP_ERROR };
  }
  return { ok: true, cap: n };
}

/** Display a cap value: undefined/absent → "Unlimited", number → grouped. */
export function formatMonthlyCap(cap: number | undefined): string {
  if (cap === undefined) return "Unlimited";
  return cap.toLocaleString("en-US");
}
