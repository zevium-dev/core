/**
 * Singular-aware credits copy: "1 credit" vs "3 credits". Small enough to
 * inline, but repeated in enough places (catalogue detail header, endpoint
 * badges, pricing summaries) that a shared helper beats copy-pasted ternaries
 * that drift ("1 credits" bugs).
 */
export function creditsLabel(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}
