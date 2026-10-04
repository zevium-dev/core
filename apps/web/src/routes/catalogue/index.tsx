import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  CatalogueBrowser,
  CatalogueSkeleton,
} from "#/components/catalogue-browser";
import {
  catalogueLoaderDeps,
  catalogueListArgs,
  validateCatalogueSearch,
} from "#/lib/catalogue-search";
import { api } from "#/lib/convex-api";

export const Route = createFileRoute("/catalogue/")({
  validateSearch: validateCatalogueSearch,
  loaderDeps: ({ search }) => catalogueLoaderDeps(search),
  loader: async ({ context, deps }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(
      api.catalogue.listPublic,
      catalogueListArgs({
        search: deps.q ?? "",
        tag: deps.tag ?? null,
        sort: deps.sort ?? "newest",
        freeOnly: deps.free ?? false,
        maxCost: deps.max ?? null,
      }),
    );
    if (typeof window !== "undefined") {
      await queryClient.prefetchQuery(queryOpts);
      return;
    }
    await queryClient.ensureQueryData(queryOpts);
  },
  component: CataloguePage,
  pendingMs: 1000,
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
  return (
    <CatalogueBrowser
      routeSearch={routeSearch}
      onSearchChange={(search, replace) => {
        void navigate({ search, replace, viewTransition: false });
      }}
    />
  );
}
