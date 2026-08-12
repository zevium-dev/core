export const ANALYTICS_RANGES = [7, 30, 90] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export function parseAnalyticsRange(value: unknown): AnalyticsRange | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  return ANALYTICS_RANGES.find((range) => range === numeric) ?? null;
}

const UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const DAY_MS = 86_400_000;

export type DailyCallPoint = {
  at: number;
  label: string;
  calls: number;
};

export function buildDailyCallSeries(
  rangeStart: number,
  callsByDay: readonly number[],
): DailyCallPoint[] {
  return callsByDay.map((calls, index) => {
    const at = rangeStart + index * DAY_MS;
    return {
      at,
      label: UTC_DAY_FORMATTER.format(at),
      calls,
    };
  });
}

/** Preserve true zero bars while keeping non-zero low-volume days visible. */
export function callBarScale(count: number, maximum: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(1, Math.max(0.06, count / maximum));
}
