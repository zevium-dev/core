/**
 * Relevance formatting for catalogue semantic-search results.
 * Gemini text-embedding-004 + Convex vectorSearch report cosine similarity,
 * which ranges from −1 (opposite) to 1 (identical). We surface it as a
 * clamped 0–100% label for a subtle relevance chip.
 */

/** Clamp a cosine score (−1..1) to a 0–1 magnitude. */
export function relevanceFraction(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

/** "87% match" style chip text. Negative / NaN scores clamp to 0%. */
export function formatRelevance(score: number): string {
  const pct = Math.round(relevanceFraction(score) * 100);
  return `${pct}% match`;
}
