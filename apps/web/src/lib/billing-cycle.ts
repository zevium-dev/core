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

/** Locale-stable integer credits for tables. */
export function formatCredits(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * Human label for a UTC calendar-month cycle [start, end).
 * Example: "Jul 2026 (UTC)".
 */
export function formatCycleMonthLabel(cycleStart: number): string {
  if (!Number.isFinite(cycleStart)) {
    return "Current cycle (UTC)";
  }
  const d = new Date(cycleStart);
  const month = d.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = d.getUTCFullYear();
  return `${month} ${year} (UTC)`;
}

export type CycleBreakdownLike = {
  totalCalls: number;
  totalCredits: number;
  byProject: readonly {
    name: string;
    slug: string;
    calls: number;
    credits: number;
  }[];
  byKey: readonly {
    keyRef: string;
    keyLabel: string;
    calls: number;
    credits: number;
  }[];
};

/** Empty-state check for cycle usage card. */
export function isCycleEmpty(breakdown: CycleBreakdownLike): boolean {
  return breakdown.totalCalls === 0 && breakdown.totalCredits === 0;
}

/**
 * Format a remaining-seconds countdown for a disabled button.
 * <= 0 → "0s"; < 60s → "Ns"; minutes compound "Nm" / "Nm Ns".
 */
export function formatCountdown(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0s";
  }
  const s = Math.ceil(totalSeconds);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
