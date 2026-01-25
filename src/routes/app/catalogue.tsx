import type { inferRouterOutputs } from "@trpc/server";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AppRouter } from "~/server";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";
import { getTrpcClient } from "~/lib/trpc/trpc";
import { cn, formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/catalogue")({
  component: RouteComponent,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(
      context.trpc.project.catalogue.queryOptions({ cursor: undefined, limit: 24 }),
    );

    void context.queryClient.ensureQueryData(context.trpc.tag.popular.queryOptions({ limit: 20 }));
  },
});

type CatalogueCursor = NonNullable<inferRouterOutputs<AppRouter>["project"]["catalogue"]["nextCursor"]>;

type CatalogueItem = inferRouterOutputs<AppRouter>["project"]["catalogue"]["items"][number];

type TagItem = inferRouterOutputs<AppRouter>["tag"]["popular"][number];

function RouteComponent() {
  const trpc = useTRPC();
  const navigate = Route.useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const debouncedSearchQuery = useDebouncedValue(searchQuery.trim(), 300);

  const popularTagsQuery = useQuery(trpc.tag.popular.queryOptions({ limit: 20 }));

  const catalogueInput = useMemo(
    () => ({
      cursor: undefined as CatalogueCursor | undefined,
      limit: 24,
      q: debouncedSearchQuery ? debouncedSearchQuery : undefined,
      tag: selectedTag === "all" ? undefined : selectedTag,
    }),
    [debouncedSearchQuery, selectedTag],
  );

  const catalogueQueryKey = useMemo(
    () => trpc.project.catalogue.infiniteQueryKey(catalogueInput),
    [trpc.project.catalogue, catalogueInput],
  );

  const catalogueQuery = useInfiniteQuery<{ items: Array<CatalogueItem>; nextCursor: CatalogueCursor | null }>({
    getNextPageParam: (lastPage: { nextCursor: CatalogueCursor | null }) => lastPage.nextCursor ?? undefined,
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => {
      const cursor = pageParam as CatalogueCursor | null;
      const client = getTrpcClient();
      return client.project.catalogue.query(
        {
          ...catalogueInput,
          cursor: cursor ?? undefined,
        },
        { signal },
      );
    },
    queryKey: catalogueQueryKey,
    staleTime: 30_000,
  });

  const projects = useMemo(() => {
    const items: Array<CatalogueItem> = [];
    for (const page of (catalogueQuery.data?.pages ?? []) as Array<{ items: Array<CatalogueItem> }>) {
      items.push(...page.items);
    }
    return items;
  }, [catalogueQuery.data]);

  const tags: Array<TagItem> = popularTagsQuery.data ?? [];

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(0);
        if (!entry?.isIntersecting) return;
        if (!catalogueQuery.hasNextPage) return;
        if (catalogueQuery.isFetchingNextPage) return;
        void catalogueQuery.fetchNextPage();
      },
      { rootMargin: "600px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [catalogueQuery.hasNextPage, catalogueQuery.isFetchingNextPage, catalogueQuery.fetchNextPage, catalogueQuery]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">API Catalogue</h1>
              <p className="text-sm text-muted-foreground">Discover public APIs across Zevium</p>
            </div>

            <div className="relative max-w-full sm:max-w-md lg:max-w-lg">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 transform text-muted-foreground" />
              <Input
                className="h-11 border-border/50 bg-background/50 pl-10 text-sm focus:border-primary/50"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search APIs by name..."
                value={searchQuery}
              />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-8 lg:flex-row">
          <aside className="w-full shrink-0 lg:w-72">
            <div className="rounded-xl border border-border/50 bg-card/30 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Popular tags</h2>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  className="rounded-full"
                  onClick={() => {
                    setSelectedTag("all");
                  }}
                  size="sm"
                  variant={selectedTag === "all" ? "default" : "secondary"}
                >
                  All
                </Button>
                {tags.map((t) => (
                  <Button
                    className="rounded-full"
                    key={t.name}
                    onClick={() => {
                      setSelectedTag(t.name);
                    }}
                    size="sm"
                    variant={selectedTag === t.name ? "default" : "secondary"}
                  >
                    <span className="max-w-36 truncate">{t.name}</span>
                    <Badge className={cn("ml-2", selectedTag === t.name ? "bg-primary-foreground/15" : "")}>
                      {t.projectCount}
                    </Badge>
                  </Button>
                ))}
              </div>
            </div>
          </aside>

          <section className="min-w-0 flex-1">
            {catalogueQuery.isError ? (
              <div className="py-16 text-center">
                <p className="text-sm text-destructive">Failed to load catalogue. Please try again later.</p>
              </div>
            ) : catalogueQuery.isPending ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Loading catalogue…</div>
            ) : projects.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-sm text-muted-foreground">No projects found.</p>
              </div>
            ) : (
              <div className="grid auto-rows-fr grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                {projects.map((p) => (
                  <Card
                    className="group flex h-full cursor-pointer flex-col border-border/40 bg-card/30 backdrop-blur-sm transition-all duration-300 hover:border-border hover:bg-card/60 hover:shadow-xl hover:shadow-primary/5"
                    key={p.id}
                    onClick={() =>
                      navigate({
                        params: { organizationSlug: p.organizationSlug, projectSlug: p.slug },
                        to: "/app/organizations/$organizationSlug/projects/$projectSlug",
                      })
                    }
                  >
                    <CardHeader>
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="line-clamp-2 text-xl leading-tight font-bold text-foreground transition-colors group-hover:text-primary">
                            {p.name}
                          </h3>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground/80">{p.organizationName}</span>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col pt-0">
                      <div className="mb-6 flex-1">
                        <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                          {p.description ?? "No description available"}
                        </p>
                      </div>

                      {p.tags.length > 0 ? (
                        <div className="mb-4 flex flex-wrap gap-2">
                          {p.tags.slice(0, 4).map((tagName) => (
                            <Badge key={tagName} variant="secondary">
                              {tagName}
                            </Badge>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-auto border-t border-border/30 pt-4">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Updated</span>
                          <time className="font-medium text-foreground/70" dateTime={p.updatedAt.toISOString()}>
                            {formatDate(p.updatedAt, { dateOnly: true })}
                          </time>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="h-10" ref={sentinelRef} />

            {catalogueQuery.isFetchingNextPage ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading more…</div>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [delayMs, value]);

  return debounced;
}
