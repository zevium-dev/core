import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { formatCredits } from "#/lib/billing-cycle";
import { mergeUsagePages } from "#/lib/activity-filters";
import type { AdminOrgView } from "../../../../../convex/admin";

const ORG_PAGE_SIZE = 25;

export const Route = createFileRoute("/admin/orgs")({
  component: AdminOrgsPage,
  head: () => ({
    meta: [{ title: "Admin Orgs · Zevium" }],
  }),
  pendingComponent: OrgsSkeleton,
});

function AdminOrgsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminOrgView[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  const args = useMemo(
    () => ({
      paginationOpts: { numItems: ORG_PAGE_SIZE, cursor },
    }),
    [cursor],
  );
  const orgsQuery = useQuery(convexQuery(api.admin.listOrgs, args));

  useEffect(() => {
    if (!orgsQuery.data || orgsQuery.isPending) return;
    const page = orgsQuery.data.page as AdminOrgView[];
    setRows((prev) => mergeUsagePages(prev, page, cursor === null));
    setIsDone(orgsQuery.data.isDone);
    setContinueCursor(orgsQuery.data.continueCursor);
  }, [orgsQuery.data, orgsQuery.isPending, cursor]);

  const firstPagePending = orgsQuery.isPending && cursor === null;
  const loadMorePending = orgsQuery.isPending && cursor !== null;
  const canLoadMore =
    !isDone && continueCursor !== null && !orgsQuery.isPending;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="text-sm text-muted-foreground">
          All mirrored Clerk organizations and their wallet balances.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Orgs</CardTitle>
          <CardDescription>Name, slug, wallet balance.</CardDescription>
        </CardHeader>
        <CardContent>
          {firstPagePending ? (
            <OrgsTableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyOrgs />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-2 py-2 font-medium">Name</th>
                      <th className="px-2 py-2 font-medium">Slug</th>
                      <th className="px-2 py-2 font-medium text-right">
                        Balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((org) => (
                      <tr key={org._id} className="border-b last:border-0">
                        <td className="px-2 py-2.5 font-medium">{org.name}</td>
                        <td className="px-2 py-2.5 font-mono text-xs text-muted-foreground">
                          {org.slug}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          <Badge variant="secondary">
                            {formatCredits(org.balance)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => {
                      if (continueCursor !== null) {
                        setCursor(continueCursor);
                      }
                    }}
                  >
                    {loadMorePending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyOrgs() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Building2 className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No organizations</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Mirrored Clerk orgs appear here once members sign in.
        </p>
      </div>
    </div>
  );
}

function OrgsTableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function OrgsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <OrgsTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}
