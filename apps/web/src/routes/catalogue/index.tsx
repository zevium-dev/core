import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { ArrowLeft, PackageSearch, Sparkles } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { FadeIn } from "#/components/motion/fade-in";
import { PublicHeader } from "#/components/public-header";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import {
  formatCataloguePriceRange,
  formatEndpointCount,
} from "#/lib/catalogue-card";
import { formatRelevance } from "#/lib/catalogue-search";
import { api } from "#/lib/convex-api";
import { cn } from "#/lib/utils";
import type { SearchListing } from "../../../../../convex/search";

const SEARCH_DEBOUNCE_MS = 250;

type CatalogueSort = "newest" | "name" | "cheapest";

/** Card shape shared by browse + semantic results; `score` only on ranked hits. */
type CatalogueCardItem = Omit<SearchListing, "score"> & { score?: number };

export const Route = createFileRoute("/catalogue/")({
  loader: async ({ context }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.listPublic, {});
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(queryOpts);
      return;
    }
    await queryClient.ensureQueryData(queryOpts);
  },
  component: CataloguePage,
  head: () => ({
    meta: [
      { title: "Catalogue · Zevium" },
      {
        name: "description",
        content: "Browse agent-ready APIs with per-call pricing.",
      },
    ],
  }),
  pendingComponent: CatalogueSkeleton,
});

function CataloguePage() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<CatalogueSort>("newest");
  const [freeOnly, setFreeOnly] = useState(false);
  const [maxCostInput, setMaxCostInput] = useState("");
  const [debouncedMaxCost, setDebouncedMaxCost] = useState<number | null>(null);

  // Semantic results: null = browse mode; [] = searched, no genuine matches
  // (shown as empty state); degraded → reset to null (silent substring fallback).
  const [semanticItems, setSemanticItems] = useState<SearchListing[] | null>(
    null,
  );

  const runSemanticAction = useAction(api.search.searchCatalogue);
  const { mutate: runSemanticSearch, isPending: semanticPending } = useMutation(
    {
      mutationFn: (query: string) => runSemanticAction({ query, limit: 20 }),
      onSuccess: (res) => {
        // Gemini down → degraded: fall back to instant substring browse silently.
        setSemanticItems(res.degraded ? null : res.items);
      },
      onError: () => setSemanticItems(null),
    },
  );

  const inSemanticMode = semanticItems !== null || semanticPending;

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const trimmed = maxCostInput.trim();
      if (trimmed === "") {
        setDebouncedMaxCost(null);
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setDebouncedMaxCost(null);
        return;
      }
      setDebouncedMaxCost(n);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [maxCostInput]);

  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    // Editing the query invalidates any prior semantic ranking → back to browse.
    setSemanticItems(null);
  };

  const submitSemanticSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchInput.trim();
    if (query.length === 0) return;
    runSemanticSearch(query);
  };

  const exitSemanticMode = () => setSemanticItems(null);

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader maxWidthClass="max-w-6xl" active="catalogue" />

      <main className="mx-auto max-w-6xl px-4 py-8 content-enter">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{ viewTransitionName: "catalogue-heading" }}
            >
              Catalogue
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Public APIs with per-call credits. No auth required to browse.
            </p>
          </div>
          <form onSubmit={submitSemanticSearch} className="flex gap-2">
            <Input
              placeholder="Search APIs…"
              className="max-w-sm"
              aria-label="Search catalogue"
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              className="shrink-0"
              aria-label="Search semantically"
              disabled={searchInput.trim().length === 0 || semanticPending}
            >
              <Sparkles className="size-4" />
              <span className="hidden sm:inline">Semantic</span>
            </Button>
          </form>
        </div>

        {inSemanticMode ? (
          <SemanticResults
            items={semanticItems}
            pending={semanticPending}
            onClear={exitSemanticMode}
          />
        ) : (
          <BrowsePanel
            debouncedSearch={debouncedSearch}
            activeTag={activeTag}
            onTagChange={setActiveTag}
            sort={sort}
            setSort={setSort}
            freeOnly={freeOnly}
            setFreeOnly={setFreeOnly}
            maxCostInput={maxCostInput}
            setMaxCostInput={setMaxCostInput}
            debouncedMaxCost={debouncedMaxCost}
          />
        )}
      </main>
    </div>
  );
}

function BrowsePanel({
  debouncedSearch,
  activeTag,
  onTagChange,
  sort,
  setSort,
  freeOnly,
  setFreeOnly,
  maxCostInput,
  setMaxCostInput,
  debouncedMaxCost,
}: {
  debouncedSearch: string;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  sort: CatalogueSort;
  setSort: (sort: CatalogueSort) => void;
  freeOnly: boolean;
  setFreeOnly: (freeOnly: boolean) => void;
  maxCostInput: string;
  setMaxCostInput: (value: string) => void;
  debouncedMaxCost: number | null;
}) {
  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="grid gap-1.5">
          <Label
            htmlFor="catalogue-sort"
            className="text-xs text-muted-foreground"
          >
            Sort
          </Label>
          <select
            id="catalogue-sort"
            aria-label="Sort catalogue"
            className="h-9 min-w-[10rem] rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] duration-[var(--dur-instant)] ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={sort}
            onChange={(e) => setSort(e.target.value as CatalogueSort)}
          >
            <option value="newest">Newest</option>
            <option value="name">Name</option>
            <option value="cheapest">Cheapest</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label
            htmlFor="catalogue-max-cost"
            className="text-xs text-muted-foreground"
          >
            Max cost (cr)
          </Label>
          <Input
            id="catalogue-max-cost"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="Any"
            className="w-28"
            aria-label="Maximum credits per call"
            value={maxCostInput}
            onChange={(e) => setMaxCostInput(e.target.value)}
          />
        </div>

        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm shadow-xs transition-[background-color,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:bg-accent/40">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={freeOnly}
            onChange={(e) => setFreeOnly(e.target.checked)}
            aria-label="Only free-tier APIs"
          />
          <span className="text-sm">Free tier only</span>
        </label>
      </div>

      <Suspense fallback={<CatalogueGridSkeleton />}>
        <CatalogueList
          search={debouncedSearch}
          activeTag={activeTag}
          onTagChange={onTagChange}
          sort={sort}
          freeOnly={freeOnly}
          maxCost={debouncedMaxCost}
        />
      </Suspense>
    </>
  );
}

function SemanticResults({
  items,
  pending,
  onClear,
}: {
  items: SearchListing[] | null;
  pending: boolean;
  onClear: () => void;
}) {
  const count = items?.length ?? 0;
  return (
    <FadeIn className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {pending
            ? "Searching semantically…"
            : count === 1
              ? "1 semantic match"
              : `${count} semantic matches`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label="Back to browse"
        >
          <ArrowLeft className="size-4" />
          Back to browse
        </Button>
      </div>

      {pending ? (
        <CatalogueGridSkeleton />
      ) : count === 0 ? (
        <CatalogueEmpty hasSearch />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((item) => (
            <CatalogueCard key={item.projectId} item={item} />
          ))}
        </div>
      )}
    </FadeIn>
  );
}

function CatalogueList({
  search,
  activeTag,
  onTagChange,
  sort,
  freeOnly,
  maxCost,
}: {
  search: string;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  sort: CatalogueSort;
  freeOnly: boolean;
  maxCost: number | null;
}) {
  const trimmed = search.trim();
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.listPublic, {
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(activeTag ? { tag: activeTag } : {}),
      sort,
      ...(freeOnly ? { hasFreeTier: true } : {}),
      ...(maxCost !== null ? { maxCost } : {}),
    }),
  );

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const item of data.items) {
      for (const tag of item.tags) set.add(tag);
    }
    if (activeTag) set.add(activeTag);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data.items, activeTag]);

  const hasFilters =
    trimmed.length > 0 || activeTag !== null || freeOnly || maxCost !== null;

  return (
    <FadeIn className="flex flex-col gap-6">
      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Tags
          </span>
          <button
            type="button"
            onClick={() => onTagChange(null)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-[color,background-color,border-color] duration-[var(--dur-instant)] ease-[var(--ease)]",
              activeTag === null
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onTagChange(activeTag === tag ? null : tag)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-[color,background-color,border-color] duration-[var(--dur-instant)] ease-[var(--ease)]",
                activeTag === tag
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {data.items.length === 0 ? (
        <CatalogueEmpty hasSearch={hasFilters} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((item) => (
            <CatalogueCard key={item.projectId} item={item} />
          ))}
        </div>
      )}
    </FadeIn>
  );
}

/** Shared catalogue card — used by both browse grid and semantic results. */
function CatalogueCard({ item }: { item: CatalogueCardItem }) {
  const priceLabel = formatCataloguePriceRange(item.pricing);
  const endpointLabel =
    item.pricing !== null && item.pricing.endpointCount > 0
      ? formatEndpointCount(item.pricing.endpointCount)
      : null;
  const freeBadge = item.pricing?.hasFreeTier === true;
  const relevance =
    item.score === undefined ? null : formatRelevance(item.score);

  return (
    <Link
      to="/catalogue/$orgSlug/$projectSlug"
      params={{ orgSlug: item.orgSlug, projectSlug: item.slug }}
      className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
        <CardHeader className="gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle
                className="text-base"
                style={{
                  viewTransitionName: `api-title-${item.slug}`,
                }}
              >
                {item.name}
              </CardTitle>
              <CardDescription className="font-mono text-xs">
                {item.orgSlug}/{item.slug}
              </CardDescription>
            </div>
            <Badge variant="secondary" className="shrink-0">
              {item.orgName}
            </Badge>
          </div>
          {item.description ? (
            <CardDescription className="line-clamp-2">
              {item.description}
            </CardDescription>
          ) : (
            <CardDescription className="text-muted-foreground/70">
              No description yet.
            </CardDescription>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {relevance ? (
              <Badge
                variant="outline"
                className="font-mono text-muted-foreground"
              >
                {relevance}
              </Badge>
            ) : null}
            {priceLabel ? (
              <Badge
                variant="outline"
                className="font-mono"
                style={{
                  viewTransitionName: `api-price-${item.slug}`,
                }}
              >
                {priceLabel}
              </Badge>
            ) : null}
            {freeBadge ? <Badge variant="secondary">Free tier</Badge> : null}
            {endpointLabel ? (
              <Badge variant="outline">{endpointLabel}</Badge>
            ) : null}
            {item.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

function CatalogueEmpty({ hasSearch }: { hasSearch: boolean }) {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center py-16 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
          <PackageSearch className="size-6 text-muted-foreground" />
        </div>
        <CardTitle>
          {hasSearch ? "No matching APIs" : "No public APIs yet"}
        </CardTitle>
        <CardDescription className="max-w-sm">
          {hasSearch
            ? "Try different search, tags, or price filters. Public listings show up here when publishers make an API public."
            : "Publishers haven't listed any public APIs yet. Check back soon, or sign in to publish your own."}
        </CardDescription>
        <div className="pt-4">
          <Button asChild variant="outline">
            <Link to="/sign-in/$">Sign in to publish</Link>
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}

function CatalogueGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="gap-3">
            <div className="flex items-start gap-3">
              <Skeleton className="size-10 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <CardDescription>
              <span className="block space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </span>
            </CardDescription>
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function CatalogueSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 space-y-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="mb-6 flex gap-3">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-36" />
        </div>
        <CatalogueGridSkeleton />
      </main>
    </div>
  );
}
