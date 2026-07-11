import { convexQuery } from "@convex-dev/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { PackageSearch } from "lucide-react";
import { Suspense, useState } from "react";

import { ThemeToggle } from "#/components/theme-toggle";
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

export const Route = createFileRoute("/catalogue")({
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
  const [search, setSearch] = useState("");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-sm font-semibold tracking-tight">
              Zevium
            </Link>
            <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
              <Link
                to="/catalogue"
                className="text-foreground"
                style={{ viewTransitionName: "catalogue-heading" }}
              >
                Catalogue
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="outline" size="sm">
              <Link to="/sign-in/$">Sign in</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 content-enter">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <Suspense fallback={<CatalogueGridSkeleton />}>
          <CatalogueList search={search} />
        </Suspense>
      </main>
    </div>
  );
}

function CatalogueList({ search }: { search: string }) {
  const trimmed = search.trim();
  const { data } = useSuspenseQuery(
    convexQuery(api.catalogue.listPublic, {
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
    }),
  );

  if (data.items.length === 0) {
    return <CatalogueEmpty hasSearch={trimmed.length > 0} />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.items.map((item) => (
        <Card
          key={item.projectId}
          className="transition-[transform,box-shadow,border-color] duration-[var(--dur-instant)] ease-[var(--ease)] hover:-translate-y-0.5 hover:shadow-sm"
        >
          <CardHeader className="gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="text-base">{item.name}</CardTitle>
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
      ))}
    </div>
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
            ? "Try a different search. Public listings show up here when publishers make an API public."
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
