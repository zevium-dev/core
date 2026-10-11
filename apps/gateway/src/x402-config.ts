/** Explicit opt-in; configured secrets alone must never activate payments. */
export function isX402Enabled(env: { X402_ENABLED?: string }): boolean {
  return env.X402_ENABLED === "true";
}
