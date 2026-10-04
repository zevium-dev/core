import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  CatalogueBrowser,
  CatalogueSkeleton,
} from "#/components/catalogue-browser";
import { validateCatalogueSearch } from "#/lib/catalogue-search";

export const Route = createFileRoute("/app/catalogue/")({
  validateSearch: validateCatalogueSearch,
  component: AppCataloguePage,
  head: () => ({ meta: [{ title: "Catalogue · Zevium" }] }),
  pendingComponent: () => <CatalogueSkeleton inApp />,
});

function AppCataloguePage() {
  const routeSearch = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <CatalogueBrowser
      inApp
      routeSearch={routeSearch}
      onSearchChange={(search, replace) => {
        void navigate({ search, replace, viewTransition: false });
      }}
    />
  );
}
