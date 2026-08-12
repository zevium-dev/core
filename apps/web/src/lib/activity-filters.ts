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

export type UsageRowIdentity = {
  eventId: string | null;
  at: number;
  keyId: string;
  endpoint: string;
  method: string;
};

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

function usageRowIdentity(row: UsageRowIdentity): string {
  return (
    row.eventId ??
    `${row.at}:${row.keyId}:${row.method.toUpperCase()}:${row.endpoint}`
  );
}

/**
 * Merge a fetched page into the accumulated list.
 * `replace` clears previous pages (filter reset / first page).
 * Dedupe by opaque public id so StrictMode double-effects don't double-append.
 */
function mergePages<T>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
  identityFor: (row: T) => string,
): T[] {
  if (replace) {
    return [...incoming];
  }
  if (incoming.length === 0) {
    return [...existing];
  }

  const seen = new Set(existing.map(identityFor));
  const next = [...existing];
  for (const row of incoming) {
    const identity = identityFor(row);
    if (!seen.has(identity)) {
      seen.add(identity);
      next.push(row);
    }
  }
  return next;
}

export function mergeUsagePages<T extends { _id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
): T[] {
  return mergePages(existing, incoming, replace, (row) => row._id);
}

export function mergePublicUsagePages<T extends UsageRowIdentity>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
): T[] {
  return mergePages(existing, incoming, replace, usageRowIdentity);
}

export function mergeHandlePages<T extends { handle: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  replace: boolean,
): T[] {
  if (replace) return [...incoming];
  const seen = new Set(existing.map((row) => row.handle));
  const next = [...existing];
  for (const row of incoming) {
    if (!seen.has(row.handle)) {
      seen.add(row.handle);
      next.push(row);
    }
  }
  return next;
}

export const ACTIVITY_PAGE_SIZE = 25;
