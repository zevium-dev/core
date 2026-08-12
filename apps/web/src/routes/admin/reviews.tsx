import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  reviewModerationSearchSchema,
  reviewQueueMode,
  type ReviewModerationRouteSearch,
} from "#/lib/route-search";
import { AdminReviewsQueue, ReviewsQueueSkeleton } from "./-reviews-ui";

export const Route = createFileRoute("/admin/reviews")({
  validateSearch: reviewModerationSearchSchema,
  component: AdminReviewsPage,
  head: () => ({ meta: [{ title: "Admin Reviews · Zevium" }] }),
  pendingComponent: ReviewsQueueSkeleton,
});

function AdminReviewsPage() {
  const mode = reviewQueueMode(Route.useSearch());
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <AdminReviewsQueue
      key={mode}
      mode={mode}
      onModeChange={(nextMode) =>
        void navigate({
          search: (previous: ReviewModerationRouteSearch) => ({
            ...previous,
            tab: nextMode === "reported" ? undefined : nextMode,
          }),
        })
      }
    />
  );
}
