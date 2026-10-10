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

export type ActivityAttributionSearch = {
  key?: string;
  member?: string;
  endpoint?: string;
  method?: string;
};

/** Never project an admin-only member filter into ordinary-member UI/query state. */
export function authorizedAttributionSearch(
  search: ActivityAttributionSearch,
  canViewOrgUsage: boolean,
): ActivityAttributionSearch {
  return {
    ...(search.key ? { key: search.key } : {}),
    ...(canViewOrgUsage && search.member ? { member: search.member } : {}),
    ...(search.endpoint ? { endpoint: search.endpoint } : {}),
    ...(search.method ? { method: search.method } : {}),
  };
}

export const ACTIVITY_PAGE_SIZE = 25;
