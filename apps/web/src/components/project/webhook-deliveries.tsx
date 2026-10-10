import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { formatRelativeTime } from "#/lib/relative-time";
import { deliveryStatusView, truncateError } from "#/lib/webhook-delivery";
export function WebhookDeliveries({
  project,
  hasEndpoint,
}: {
  project: Doc<"projects">;
  hasEndpoint: boolean;
}) {
  const deliveriesQuery = useQuery(
    convexQuery(api.webhooks.listDeliveries, {
      projectId: project._id,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  const deliveries = deliveriesQuery.data?.page ?? [];

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Recent deliveries</h3>
        {!hasEndpoint ||
        deliveriesQuery.isPending ||
        deliveriesQuery.isError ? null : (
          <Badge variant="outline">{deliveries.length}</Badge>
        )}
      </div>
      {deliveriesQuery.isPending ? (
        <div className="space-y-2" aria-label="Loading deliveries">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : deliveriesQuery.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            {humanError(
              deliveriesQuery.error,
              "Could not load recent deliveries.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void deliveriesQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !hasEndpoint ? (
        <p className="text-xs text-muted-foreground">
          Create an endpoint to start receiving deliveries.
        </p>
      ) : deliveries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No deliveries yet. Publish or deprecate a version, or change project
          visibility, to trigger an event.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {deliveries.map((d) => {
            const view = deliveryStatusView(d.status);
            const err = truncateError(d.lastError);
            return (
              <li
                key={d.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{d.event}</span>
                    <Badge
                      variant={view.badgeVariant}
                      className={view.className}
                    >
                      {view.dotClassName.length > 0 ? (
                        <span
                          className={`size-1.5 rounded-full ${view.dotClassName}`}
                        />
                      ) : null}
                      {view.label}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                    {err.length > 0 ? ` · ${err}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {formatRelativeTime(d.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
