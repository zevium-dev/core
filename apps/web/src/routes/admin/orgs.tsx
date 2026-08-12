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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { formatCredits } from "#/lib/billing-cycle";
import { mergeHandlePages } from "#/lib/activity-filters";
import { humanError } from "#/lib/human-error";
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
    setRows((prev) => mergeHandlePages(prev, page, cursor === null));
    setIsDone(orgsQuery.data.isDone);
    setContinueCursor(orgsQuery.data.continueCursor);
  }, [orgsQuery.data, orgsQuery.isPending, cursor]);

  const firstPagePending = orgsQuery.isPending && cursor === null;
  const loadMorePending = orgsQuery.isPending && cursor !== null;
  const canLoadMore =
    !isDone &&
    continueCursor !== null &&
    !orgsQuery.isPending &&
    !orgsQuery.isError;

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
          ) : orgsQuery.isError && rows.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyTitle>Could not load organizations</EmptyTitle>
                <EmptyDescription>
                  {humanError(
                    orgsQuery.error,
                    "Platform organizations are temporarily unavailable.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void orgsQuery.refetch()}
                >
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : rows.length === 0 ? (
            <EmptyOrgs />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-2 py-2 font-medium">
                        Name
                      </th>
                      <th scope="col" className="px-2 py-2 font-medium">
                        Slug
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((org) => (
                      <tr key={org.handle} className="border-b last:border-0">
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
              {orgsQuery.isError && rows.length > 0 ? (
                <div
                  className="flex flex-wrap items-center justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3"
                  role="alert"
                >
                  <p className="text-sm text-destructive">
                    More organizations could not be loaded. Existing rows are
                    still available.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void orgsQuery.refetch()}
                  >
                    Retry page
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
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Building2 />
        </EmptyMedia>
        <EmptyTitle>No organizations</EmptyTitle>
        <EmptyDescription>
          Mirrored Clerk orgs appear here once members sign in.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
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
