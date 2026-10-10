/** Truncate opaque key ids for monospace table cells. */
export function truncateKeyId(keyId: string, head = 6, tail = 4): string {
  const trimmed = keyId.trim();
  if (trimmed.length === 0) {
    return "—";
  }
  if (head < 0 || tail < 0) {
    return trimmed;
  }
  if (trimmed.length <= head + tail + 1) {
    return trimmed;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

export { formatCredits, formatCycleMonthLabel } from "./format";

export type CycleBreakdownLike = {
  totalCalls: number;
  totalCredits: number;

  byProject?: readonly unknown[];
  byKey?: readonly unknown[];
};

/** Empty-state check for cycle usage card. */
export function isCycleEmpty(breakdown: CycleBreakdownLike): boolean {
  return breakdown.totalCalls === 0 && breakdown.totalCredits === 0;
}
