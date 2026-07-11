import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { PackageSearch } from "lucide-react";
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
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { cn } from "#/lib/utils";

const SEARCH_DEBOUNCE_MS = 250;

export const Route = createFileRoute("/catalogue/")({
  loader: async ({ context }) => {
    const { queryClient } = context;
    await queryClient.ensureQueryData(
      convexQuery(api.catalogue.listPublic, {}),
    );
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

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

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
          <Input
            placeholder="Search APIs…"
            className="max-w-sm"
            aria-label="Search catalogue"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <Suspense fallback={<CatalogueGridSkeleton />}>
          <CatalogueList
            search={debouncedSearch}
            activeTag={activeTag}
            onTagChange={setActiveTag}
          />
        </Suspense>
      </main>
    </div>
  );
}

function CatalogueList({
  search,
  activeTag,
  onTagChange,
}: {
  search: string;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
}) {
  const trimmed = search.trim();
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.listPublic, {
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(activeTag ? { tag: activeTag } : {}),
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
        <CatalogueEmpty hasSearch={trimmed.length > 0 || activeTag !== null} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((item) => (
            <Link
              key={item.projectId}
              to="/catalogue/$orgSlug/$projectSlug"
              params={{ orgSlug: item.orgSlug, projectSlug: item.slug }}
              className="group block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] group-hover:-translate-y-0.5 group-hover:shadow-sm group-active:scale-[0.98]">
                <CardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {/* VT morph: catalogue card → API detail title (api-title-{slug})
                          No api-logo/api-price morph: listPublic has no logo/price fields yet. */}
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
                  {item.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {item.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </FadeIn>
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
            ? "Try a different search or tag. Public listings show up here when publishers make an API public."
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
        <CatalogueGridSkeleton />
      </main>
    </div>
  );
}
