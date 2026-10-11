/** Per-isolate budget: random scopes cannot cause unbounded provider reads.
 * Warm authority and scheduled refreshes do not consume this cold-start budget. */
export class ColdRefreshBudget {
  private tokens = 20;
  private at = Date.now();
  take(now = Date.now()) {
    this.tokens = Math.min(20, this.tokens + Math.max(0, now - this.at) / 200);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
export const coldRefreshBudget = new ColdRefreshBudget();
export const COLD_FILL_MS = 2000;
export const NEGATIVE_TTL_MS = 10_000;
/** An alarm fill may already be running with its larger background budget.
 * Bound the cold caller's wait as well as the outbound fetches. */
export async function waitForColdFill(fill: Promise<void>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fill,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, COLD_FILL_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
