import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export const CATALOGUE_SEARCH_DEBOUNCE_MS = 250;

export type CatalogueSortValue = "newest" | "name" | "cheapest";

export type CatalogueRouteSearch = {
  q?: string;
  tag?: string;
  sort?: Exclude<CatalogueSortValue, "newest">;
  free?: true;
  semantic?: true;
  max?: number;
};

export type CatalogueSearchDraft = {
  q: string;
  tag: string | null;
  sort: CatalogueSortValue;
  freeOnly: boolean;
  maxCostInput: string;
  semantic: boolean;
};

export type CatalogueLoaderDeps = Pick<
  CatalogueRouteSearch,
  "q" | "tag" | "sort" | "free" | "max"
>;

export function parseCatalogueMaxCost(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function validateCatalogueSearch(
  search: Record<string, unknown>,
): CatalogueRouteSearch {
  const max = parseCatalogueMaxCost(search.max);
  return {
    q:
      typeof search.q === "string" && search.q.trim() !== ""
        ? search.q
        : undefined,
    tag: typeof search.tag === "string" ? search.tag : undefined,
    sort:
      search.sort === "name" || search.sort === "cheapest"
        ? search.sort
        : undefined,
    free:
      search.free === true || search.free === "1" || search.free === 1
        ? true
        : undefined,
    semantic:
      search.semantic === true || search.semantic === "1" ? true : undefined,
    max,
  };
}

/** Semantic-only URL changes must not retrigger exact catalogue loader traffic. */
export function catalogueLoaderDeps(
  search: CatalogueRouteSearch,
): CatalogueLoaderDeps {
  return {
    q: search.q,
    tag: search.tag,
    sort: search.sort,
    free: search.free,
    max: search.max,
  };
}

export function catalogueUrlSearch(
  draft: CatalogueSearchDraft,
): CatalogueRouteSearch {
  return {
    q: draft.q.trim() === "" ? undefined : draft.q,
    tag: draft.tag ?? undefined,
    sort: draft.sort === "newest" ? undefined : draft.sort,
    free: draft.freeOnly || undefined,
    max: parseCatalogueMaxCost(draft.maxCostInput),
    semantic: draft.semantic || undefined,
  };
}

/**
 * Local field draft synchronized to canonical URL state. User edits commit only
 * after the debounce. A back/forward URL change cancels stale pending commits.
 */
export function useDebouncedUrlDraft<T>(
  committedValue: T,
  onCommit: (value: T) => void,
  delayMs = CATALOGUE_SEARCH_DEBOUNCE_MS,
): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(committedValue);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => {
    if (Object.is(draft, committedValue)) return;
    const handle = window.setTimeout(() => commitRef.current(draft), delayMs);
    return () => window.clearTimeout(handle);
  }, [committedValue, delayMs, draft]);

  return [draft, setDraft];
}

/**
 * Relevance formatting for catalogue semantic-search results.
 * Gemini text-embedding-004 + Convex vectorSearch report cosine similarity,
 * which ranges from −1 (opposite) to 1 (identical). We surface it as a
 * clamped 0–100% label for a subtle relevance chip.
 */

/** Clamp a cosine score (−1..1) to a 0–1 magnitude. */
export function relevanceFraction(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

/** "87% match" style chip text. Negative / NaN scores clamp to 0%. */
export function formatRelevance(score: number): string {
  const pct = Math.round(relevanceFraction(score) * 100);
  return `${pct}% match`;
}
