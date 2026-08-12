import { convexQuery } from "@convex-dev/react-query";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { ArrowLeft, PackageSearch, Sparkles } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { FadeIn } from "#/components/motion/fade-in";
import { PublicHeader } from "#/components/public-header";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Separator } from "#/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import {
  formatCataloguePriceRange,
  formatEndpointCount,
} from "#/lib/catalogue-card";
import { formatRelevance } from "#/lib/catalogue-search";
import { api } from "#/lib/convex-api";
import type { SearchListing } from "../../../../../convex/search";

const SEARCH_DEBOUNCE_MS = 250;

type CatalogueSort = "newest" | "name" | "cheapest";

/** Card shape shared by browse + semantic results; `score` only on ranked hits. */
type CatalogueCardItem = Omit<SearchListing, "score"> & { score?: number };

export const Route = createFileRoute("/catalogue/")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
    tag: typeof search.tag === "string" ? search.tag : undefined,
    sort:
      search.sort === "name" || search.sort === "cheapest"
        ? search.sort
        : ("newest" as CatalogueSort),
    free:
      search.free === true || search.free === "1" || search.free === 1
        ? true
        : undefined,
    semantic:
      search.semantic === true || search.semantic === "1" ? true : undefined,
    max:
      (typeof search.max === "string" || typeof search.max === "number") &&
      /^\d+$/.test(String(search.max))
        ? Number(search.max)
        : undefined,
  }),
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
  const routeSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [searchInput, setSearchInput] = useState(routeSearch.q);
  const [debouncedSearch, setDebouncedSearch] = useState(routeSearch.q);
  const [activeTag, setActiveTag] = useState<string | null>(
    routeSearch.tag ?? null,
  );
  const [sort, setSort] = useState<CatalogueSort>(routeSearch.sort);
  const [freeOnly, setFreeOnly] = useState(routeSearch.free ?? false);
  const [maxCostInput, setMaxCostInput] = useState(
    routeSearch.max === undefined ? "" : String(routeSearch.max),
  );
  const [debouncedMaxCost, setDebouncedMaxCost] = useState<number | null>(null);

  // Semantic results: null = browse mode; [] = searched, no genuine matches
  // (shown as empty state); degraded → reset to null (silent substring fallback).
  const [semanticItems, setSemanticItems] = useState<SearchListing[] | null>(
    null,
  );
  const [semanticState, setSemanticState] = useState<
    "idle" | "ready" | "degraded" | "error"
  >("idle");
  const runSemanticAction = useAction(api.search.searchCatalogue);
  const { mutate: runSemanticSearch, isPending: semanticPending } = useMutation(
    {
      mutationFn: (query: string) => runSemanticAction({ query, limit: 20 }),
      onSuccess: (res) => {
        setSemanticState(res.degraded ? "degraded" : "ready");
        setSemanticItems(res.degraded ? null : res.items);
      },
      onError: () => {
        setSemanticItems(null);
        setSemanticState("error");
      },
    },
  );

  const inSemanticMode = semanticItems !== null || semanticPending;

  useEffect(() => {
    if (routeSearch.semantic && routeSearch.q.trim() !== "") {
      runSemanticSearch(routeSearch.q.trim());
    } else {
      setSemanticItems(null);
      setSemanticState("idle");
    }
  }, [routeSearch.q, routeSearch.semantic, runSemanticSearch]);

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

  useEffect(() => {
    void navigate({
      search: {
        q: searchInput || undefined,
        tag: activeTag ?? undefined,
        sort: sort === "newest" ? undefined : sort,
        free: freeOnly || undefined,
        max:
          maxCostInput.trim() === "" ? undefined : Number(maxCostInput.trim()),
        semantic: routeSearch.semantic ? true : undefined,
      },
      replace: true,
    });
  }, [
    activeTag,
    freeOnly,
    maxCostInput,
    navigate,
    routeSearch.semantic,
    searchInput,
    sort,
  ]);

  useEffect(() => {
    setSearchInput(routeSearch.q);
    setDebouncedSearch(routeSearch.q);
    setActiveTag(routeSearch.tag ?? null);
    setSort(routeSearch.sort);
    setFreeOnly(routeSearch.free ?? false);
    setMaxCostInput(
      routeSearch.max === undefined ? "" : String(routeSearch.max),
    );
  }, [
    routeSearch.free,
    routeSearch.max,
    routeSearch.q,
    routeSearch.sort,
    routeSearch.tag,
  ]);

  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    // Editing the query invalidates any prior semantic ranking → back to browse.
    setSemanticItems(null);
    setSemanticState("idle");
    if (routeSearch.semantic) {
      void navigate({
        search: {
          q: value || undefined,
          tag: activeTag ?? undefined,
          sort: sort === "newest" ? undefined : sort,
          free: freeOnly || undefined,
          max: maxCostInput.trim() ? Number(maxCostInput.trim()) : undefined,
          semantic: undefined,
        },
        replace: true,
      });
    }
  };

  const submitSemanticSearch = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const query = searchInput.trim();
    if (query.length === 0) return;
    void navigate({
      search: {
        q: query,
        tag: activeTag ?? undefined,
        sort: sort === "newest" ? undefined : sort,
        free: freeOnly || undefined,
        max: maxCostInput.trim() ? Number(maxCostInput.trim()) : undefined,
        semantic: true,
      },
    });
  };

  const exitSemanticMode = () => {
    void navigate({
      search: {
        q: searchInput || undefined,
        tag: activeTag ?? undefined,
        sort: sort === "newest" ? undefined : sort,
        free: freeOnly || undefined,
        max: maxCostInput.trim() ? Number(maxCostInput.trim()) : undefined,
        semantic: undefined,
      },
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <PublicHeader active="catalogue" />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 content-enter">
        <div>
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
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Find an API</CardTitle>
            <CardDescription>
              Filter exact metadata instantly or rank results by semantic
              intent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitSemanticSearch}>
              <FieldGroup className="gap-6">
                <Field>
                  <FieldLabel htmlFor="catalogue-search">Search</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id="catalogue-search"
                      name="catalogue-search"
                      placeholder="Describe an API or task…"
                      className="min-w-0 flex-1"
                      value={searchInput}
                      onChange={(e) => handleSearchInput(e.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      className="shrink-0"
                      aria-label="Search semantically"
                      disabled={
                        searchInput.trim().length === 0 || semanticPending
                      }
                    >
                      <Sparkles data-icon="inline-start" />
                      <span className="hidden sm:inline">Semantic</span>
                    </Button>
                  </div>
                  <FieldDescription>
                    Typing filters names and descriptions. Semantic search ranks
                    APIs by intent.
                  </FieldDescription>
                  <p
                    aria-live="polite"
                    className="text-sm text-muted-foreground"
                  >
                    {semanticPending
                      ? "Searching semantically…"
                      : semanticState === "degraded"
                        ? "Semantic search is unavailable; showing exact matches."
                        : semanticState === "error"
                          ? "Semantic search failed. You can retry or browse exact matches."
                          : semanticState === "ready"
                            ? "Semantic results are ready."
                            : ""}
                  </p>
                  {(semanticState === "degraded" ||
                    semanticState === "error") &&
                  searchInput.trim() !== "" ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="px-0"
                      onClick={() => runSemanticSearch(searchInput.trim())}
                    >
                      Retry semantic search
                    </Button>
                  ) : null}
                </Field>

                {inSemanticMode ? null : (
                  <BrowseFilters
                    sort={sort}
                    setSort={setSort}
                    freeOnly={freeOnly}
                    setFreeOnly={setFreeOnly}
                    maxCostInput={maxCostInput}
                    setMaxCostInput={setMaxCostInput}
                  />
                )}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

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
            freeOnly={freeOnly}
            debouncedMaxCost={debouncedMaxCost}
          />
        )}
      </main>
    </div>
  );
}

function BrowseFilters({
  sort,
  setSort,
  freeOnly,
  setFreeOnly,
  maxCostInput,
  setMaxCostInput,
}: {
  sort: CatalogueSort;
  setSort: (sort: CatalogueSort) => void;
  freeOnly: boolean;
  setFreeOnly: (freeOnly: boolean) => void;
  maxCostInput: string;
  setMaxCostInput: (value: string) => void;
}) {
  return (
    <FieldGroup className="gap-4 sm:flex-row sm:items-end">
      <Field className="sm:max-w-40">
        <FieldLabel htmlFor="catalogue-sort">Sort</FieldLabel>
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as CatalogueSort)}
        >
          <SelectTrigger id="catalogue-sort" aria-label="Sort catalogue">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="cheapest">Cheapest</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <Field className="sm:max-w-28">
        <FieldLabel htmlFor="catalogue-max-cost">Max cost (cr)</FieldLabel>
        <Input
          id="catalogue-max-cost"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="Any"
          aria-label="Maximum credits per call"
          value={maxCostInput}
          onChange={(e) => setMaxCostInput(e.target.value)}
        />
      </Field>

      <Field orientation="horizontal" className="w-fit sm:h-9">
        <Checkbox
          id="catalogue-free-tier"
          checked={freeOnly}
          onCheckedChange={(checked) => setFreeOnly(checked === true)}
        />
        <FieldLabel htmlFor="catalogue-free-tier">Free tier only</FieldLabel>
      </Field>
    </FieldGroup>
  );
}

function BrowsePanel({
  debouncedSearch,
  activeTag,
  onTagChange,
  sort,
  freeOnly,
  debouncedMaxCost,
}: {
  debouncedSearch: string;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  sort: CatalogueSort;
  freeOnly: boolean;
  debouncedMaxCost: number | null;
}) {
  return (
    <>
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
          <ArrowLeft data-icon="inline-start" />
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
            <CatalogueCard
              key={`${item.publisherHandle}/${item.slug}`}
              item={item}
            />
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
        <FieldSet className="gap-3">
          <FieldLegend variant="label">Tags</FieldLegend>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={2}
            value={activeTag ?? "__all"}
            onValueChange={(value) =>
              onTagChange(value === "" || value === "__all" ? null : value)
            }
            className="flex-wrap justify-start"
            aria-label="Filter catalogue by tag"
          >
            <ToggleGroupItem value="__all" aria-label="Show all tags">
              All
            </ToggleGroupItem>
            {tags.map((tag) => (
              <ToggleGroupItem
                key={tag}
                value={tag}
                aria-label={`Filter by ${tag}`}
              >
                {tag}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>
      ) : null}

      {data.items.length === 0 ? (
        <CatalogueEmpty hasSearch={hasFilters} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((item) => (
            <CatalogueCard
              key={`${item.publisherHandle}/${item.slug}`}
              item={item}
            />
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
      to="/catalogue/$publisherHandle/$projectSlug"
      params={{ publisherHandle: item.publisherHandle, projectSlug: item.slug }}
      className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-[translate,scale,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-active:scale-100">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <CardTitle
              className="min-w-0 break-words"
              style={{
                viewTransitionName: `api-title-${item.slug}`,
              }}
            >
              {item.name}
            </CardTitle>
            <Badge
              variant="secondary"
              className="max-w-full shrink-0 truncate"
              title={item.orgName}
            >
              {item.orgName}
            </Badge>
          </div>
          <CardDescription className="min-w-0">
            <code className="break-all">
              {item.publisherHandle}/{item.slug}
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          {item.description ? (
            <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
              {item.description}
            </p>
          ) : (
            <p className="flex-1 text-sm text-muted-foreground">
              No description yet.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {relevance ? (
              <Badge variant="outline">
                <code>{relevance}</code>
              </Badge>
            ) : null}
            {priceLabel ? (
              <Badge
                variant="outline"
                style={{
                  viewTransitionName: `api-price-${item.slug}`,
                }}
              >
                <code>{priceLabel}</code>
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
        </CardContent>
      </Card>
    </Link>
  );
}

function CatalogueEmpty({ hasSearch }: { hasSearch: boolean }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageSearch />
        </EmptyMedia>
        <EmptyTitle>
          {hasSearch ? "No matching APIs" : "No public APIs yet"}
        </EmptyTitle>
        <EmptyDescription>
          {hasSearch
            ? "Try different search, tags, or price filters. Public listings show up here when publishers make an API public."
            : "Publishers haven't listed any public APIs yet. Check back soon, or sign in to publish your own."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {hasSearch ? (
          <Button asChild variant="outline">
            <Link to="/catalogue" search={{}}>
              Clear search and filters
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link to="/sign-in/$">Sign in to publish</Link>
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}

function CatalogueGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-2/3" />
            <CardAction>
              <Skeleton className="h-5 w-24 rounded-full" />
            </CardAction>
            <Skeleton className="h-3 w-1/3" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CatalogueSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      <header>
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <Separator />
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
            <div className="flex flex-col gap-4 sm:flex-row">
              <Skeleton className="h-14 w-full sm:w-40" />
              <Skeleton className="h-14 w-full sm:w-28" />
              <Skeleton className="h-9 w-36 sm:self-end" />
            </div>
          </CardContent>
        </Card>
        <CatalogueGridSkeleton />
      </main>
    </div>
  );
}
