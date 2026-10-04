type ApiDetailTab = "try" | "docs" | "agent";
type PlaygroundMode = "mock" | "live";

export type ApiDetailSearch = {
  tab: ApiDetailTab;
  mode: PlaygroundMode;
  operation?: string;
};

export function validateApiDetailSearch(
  search: Record<string, unknown>,
): ApiDetailSearch {
  return {
    tab: search.tab === "docs" || search.tab === "agent" ? search.tab : "try",
    mode: search.mode === "live" ? "live" : "mock",
    operation:
      typeof search.operation === "string" ? search.operation : undefined,
  };
}
