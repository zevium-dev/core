import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  CatalogueDetail,
  ApiDetailSkeleton,
} from "#/components/catalogue-detail";
import { validateApiDetailSearch } from "#/lib/catalogue-detail-search";
import { api } from "#/lib/convex-api";

export const Route = createFileRoute(
  "/catalogue/$publisherHandle/$projectSlug",
)({
  validateSearch: validateApiDetailSearch,
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const queryOpts = convexQuery(api.catalogue.getPublicDetail, {
      publisherHandle: params.publisherHandle,
      projectSlug: params.projectSlug,
    });
    if (typeof window !== "undefined") {
      // The complete detail surface must exist before the new snapshot.
      await queryClient.prefetchQuery(queryOpts);
      return;
    }
    try {
      await queryClient.ensureQueryData(queryOpts);
    } catch {
      // Keep transient Convex failures inside product UI instead of leaking
      // TanStack's raw server error page.
    }
  },
  component: ApiDetailPage,
  head: ({ params }) => ({
    meta: [
      {
        title: `${params.projectSlug} · Catalogue · Zevium`,
      },
      {
        name: "description",
        content: "API pricing, docs, and try-it playground.",
      },
    ],
  }),
  pendingComponent: ApiDetailSkeleton,
  // Keep the card snapshot through ordinary fetches; slow requests still show
  // the layout-stable skeleton. An immediate skeleton loses the source morph.
  pendingMs: 1000,
});

function ApiDetailPage() {
  const params = Route.useParams();
  const routeSearch = Route.useSearch();
  const { userId } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <CatalogueDetail
      {...params}
      routeSearch={routeSearch}
      userId={userId}
      onSearchChange={(search, replace) => {
        void navigate({ search, replace });
      }}
    />
  );
}
