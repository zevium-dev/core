import { createFileRoute } from "@tanstack/react-router";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";

export const Route = createFileRoute("/app/")({
  component: DashboardPage,
  head: () => ({
    meta: [{ title: "Dashboard · Zevium" }],
  }),
});

function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Wallet, recent calls, and quick actions.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Wallet balance</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <Skeleton className="h-9 w-24" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-32" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Calls this cycle</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <Skeleton className="h-9 w-16" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-40" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Projected spend</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              <Skeleton className="h-9 w-20" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-36" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>Latest metered gateway activity</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
