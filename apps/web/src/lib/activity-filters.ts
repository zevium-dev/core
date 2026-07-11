/** Time-range presets for the settings activity call log. */
export type ActivityTimeRange = "24h" | "7d" | "30d" | "all";

export const ACTIVITY_TIME_RANGES: readonly ActivityTimeRange[] = [
  "24h",
  "7d",
  "30d",
  "all",
] as const;

export const ACTIVITY_TIME_RANGE_LABELS: Record<ActivityTimeRange, string> = {
  "24h": "Last 24h",
  "7d": "Last 7d",
  "30d": "Last 30d",
  all: "All time",
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Lower bound for `api.usage.listForOrg` `since` arg.
 * `all` → undefined (no lower bound). Window is half-open [since, now].
 */
export function activitySinceMs(
  range: ActivityTimeRange,
  now: number = Date.now(),
): number | undefined {
  switch (range) {
    case "24h":
      return now - 24 * HOUR_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
      return undefined;
  }
}

/** Coerce unknown search/UI value to a known range; default all. */
export function parseActivityTimeRange(raw: unknown): ActivityTimeRange {
  if (raw === "24h" || raw === "7d" || raw === "30d" || raw === "all") {
    return raw;
  }
  return "all";
}

export type UsageRowId = { _id: string };

/**
 * Merge a fetched page into the accumulated list.
 * `replace` clears previous pages (filter reset / first page).
 * Dedupe by `_id` so StrictMode double-effects don't double-append.
 */
export function mergeUsagePages<T extends UsageRowId>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
): T[] {
  if (replace) {
    return [...incoming];
  }
  if (incoming.length === 0) {
    return [...existing];
  }
  const seen = new Set(existing.map((row) => row._id));
  const next = [...existing];
  for (const row of incoming) {
    if (!seen.has(row._id)) {
      seen.add(row._id);
      next.push(row);
    }
  }
  return next;
}

export const ACTIVITY_PAGE_SIZE = 25;
