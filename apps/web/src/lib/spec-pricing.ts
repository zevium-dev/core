import { extractPricing, parseSpec } from "@zevium/shared";

import { creditsLabel } from "./credits-label";

export type PricingSummary = {
  endpointCount: number;
  minCredits: number | null;
  maxCredits: number | null;
  freeTier: number;
};

export function summarizeDraftPricing(draft: string): PricingSummary | null {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return {
      endpointCount: 0,
      minCredits: null,
      maxCredits: null,
      freeTier: 0,
    };
  }

  try {
    const spec = parseSpec(trimmed);
    let endpointCount = 0;
    let minCredits: number | null = null;
    let maxCredits: number | null = null;
    let freeTier = 0;

    for (const pathItem of Object.values(spec.paths)) {
      for (const op of Object.values(pathItem)) {
        if (op === undefined || Array.isArray(op)) continue;
        endpointCount += 1;
        const pricing = extractPricing(op);
        const cost = pricing.cost;
        minCredits = minCredits === null ? cost : Math.min(minCredits, cost);
        maxCredits = maxCredits === null ? cost : Math.max(maxCredits, cost);
        if (pricing.freeTier !== undefined && pricing.freeTier > 0) {
          freeTier += 1;
        }
      }
    }

    return { endpointCount, minCredits, maxCredits, freeTier };
  } catch {
    return null;
  }
}

export function formatPricingSummary(summary: PricingSummary): string {
  if (summary.endpointCount === 0) {
    return "0 endpoints";
  }
  if (summary.minCredits === null || summary.maxCredits === null) {
    return `${summary.endpointCount} endpoints`;
  }
  const range =
    summary.minCredits === summary.maxCredits
      ? creditsLabel(summary.minCredits)
      : `${summary.minCredits}–${summary.maxCredits} credits`;
  const free = summary.freeTier > 0 ? `, free tier on ${summary.freeTier}` : "";
  return `${summary.endpointCount} endpoints, ${range}${free}`;
}
