import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";

export const Route = createFileRoute("/app/settings/activity")({
  component: ActivityPage,
  head: () => ({
    meta: [{ title: "Activity · Zevium" }],
  }),
});

/**
 * Call log placeholder.
 * Convex `usageEvents` table exists (schema) but no public query for
 * org-scoped list yet (wallets/recordUsage is internal-only). Empty state
 * until a listUsage query lands.
 */
function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Account activity and metered call log.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>
            Timestamp, API, endpoint, status, credits, latency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Activity className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No activity yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Usage events land after gateway calls. Org list query is not
                exposed yet — this page shows an empty state only.
              </p>
            </div>
            <Link
              to="/catalogue"
              className="text-sm font-medium text-primary link-draw"
            >
              Browse catalogue
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
