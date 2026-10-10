import { type SpecEndpointRow } from "./spec-endpoints";

import { creditsLabel } from "./credits-label";

export type PricingSummary = {
  endpointCount: number;
  minCredits: number | null;
  maxCredits: number | null;
  freeTier: number;
};

export function summarizeEndpoints(
  endpoints: SpecEndpointRow[],
): PricingSummary {
  let minCredits: number | null = null;
  let maxCredits: number | null = null;
  let freeTier = 0;
  for (const endpoint of endpoints) {
    minCredits =
      minCredits === null ? endpoint.cost : Math.min(minCredits, endpoint.cost);
    maxCredits =
      maxCredits === null ? endpoint.cost : Math.max(maxCredits, endpoint.cost);
    if ((endpoint.freeTier ?? 0) > 0) freeTier += 1;
  }
  return { endpointCount: endpoints.length, minCredits, maxCredits, freeTier };
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
