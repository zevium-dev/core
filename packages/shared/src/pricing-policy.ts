/**
 * Shared build-time switch for web, Convex, and gateway. Keep disabled until
 * the deferred LLM credit policy is approved; deploy all three when changing it.
 * A function lets regression tests exercise both states without runtime env drift.
 */
export function isTokenPricingEnabled(): boolean {
  return false;
}
