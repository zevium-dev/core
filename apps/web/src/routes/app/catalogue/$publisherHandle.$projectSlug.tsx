import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  ApiDetailSkeleton,
  CatalogueDetail,
} from "#/components/catalogue-detail";
import { validateApiDetailSearch } from "#/lib/catalogue-detail-search";

export const Route = createFileRoute(
  "/app/catalogue/$publisherHandle/$projectSlug",
)({
  validateSearch: validateApiDetailSearch,
  // Subscribe after the app auth/mirror boundary is ready. Cold detail loads
  // fall back to the page entrance until the complete card-morph target exists.
  component: AppApiDetailPage,
  head: ({ params }) => ({
    meta: [{ title: `${params.projectSlug} · Catalogue · Zevium` }],
  }),
  pendingComponent: () => <ApiDetailSkeleton inApp />,
});

function AppApiDetailPage() {
  const params = Route.useParams();
  const routeSearch = Route.useSearch();
  const { userId } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <CatalogueDetail
      inApp
      {...params}
      routeSearch={routeSearch}
      userId={userId}
      onSearchChange={(search, replace) => {
        void navigate({ search, replace });
      }}
    />
  );
}
