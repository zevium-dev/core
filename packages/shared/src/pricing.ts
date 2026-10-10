/** Hard economic boundary: no single call can consume over a $100 credit pack. */
export const MAX_ENDPOINT_COST_CREDITS = 1_000_000;

/** Keeps daily free-tier counters bounded to a realistic launch-scale value. */
export const MAX_DAILY_FREE_TIER_CALLS = 1_000_000;

/** Rates are whole credits per million tokens; maxPerCall is a hard hold cap. */
export interface TokenPricing {
  per: "token";
  input: number;
  output: number;
  maxPerCall?: number;
}

export function parseTokenPricing(value: unknown): TokenPricing {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Token pricing must be an object");
  }
  const row = value as Record<string, unknown>;
  if (
    row.per !== "token" ||
    Object.keys(row).some(
      (key) => !["per", "input", "output", "maxPerCall"].includes(key),
    )
  ) {
    throw new Error(
      'x-zevium-cost token pricing requires per: "token", input, output, and optional maxPerCall',
    );
  }
  for (const name of ["input", "output", "maxPerCall"] as const) {
    const rate = row[name];
    if (name === "maxPerCall" && rate === undefined) continue;
    if (
      typeof rate !== "number" ||
      !Number.isSafeInteger(rate) ||
      rate < (name === "maxPerCall" ? 1 : 0) ||
      rate > MAX_ENDPOINT_COST_CREDITS
    ) {
      throw new Error(
        `Token ${name} must be a safe integer between ${name === "maxPerCall" ? 1 : 0} and ${MAX_ENDPOINT_COST_CREDITS}`,
      );
    }
  }
  return {
    per: "token",
    input: row.input as number,
    output: row.output as number,
    ...(row.maxPerCall === undefined
      ? {}
      : { maxPerCall: row.maxPerCall as number }),
  };
}

/** Round holds up; round actual charges down to the ledger's whole-credit unit. */
export function tokenCredits(
  pricing: TokenPricing,
  input: number,
  output: number,
  hold = false,
): number {
  const numerator =
    BigInt(input) * BigInt(pricing.input) +
    BigInt(output) * BigInt(pricing.output);
  const credits = Number((numerator + (hold ? 999_999n : 0n)) / 1_000_000n);
  return Math.min(credits, pricing.maxPerCall ?? MAX_ENDPOINT_COST_CREDITS);
}

export function tokenPricingLabel(pricing: TokenPricing): string {
  return `${pricing.input} input / ${pricing.output} output credits per 1M tokens`;
}

export interface EndpointPricing {
  token?: TokenPricing;
  /** Credits per call, or token hold ceiling; no implicit price */
  cost: number;
  /** Free calls per day — `x-zevium-free-tier`, publisher-funded */
  freeTier?: number;
}
