import { ListBoundary } from "#/components/list-boundary";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "#/components/ui/table";
import { usePaginatedQuery } from "convex/react";
import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";

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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import { formatCredits } from "#/lib/billing-cycle";

const ORG_PAGE_SIZE = 25;

export const Route = createFileRoute("/admin/orgs")({
  component: () => (
    <ListBoundary label="organizations">
      <AdminOrgsPage />
    </ListBoundary>
  ),
  head: () => ({
    meta: [{ title: "Admin Orgs · Zevium" }],
  }),
  pendingComponent: OrgsSkeleton,
});

function AdminOrgsPage() {
  const {
    results: rows,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.admin.listOrgs,
    {},
    { initialNumItems: ORG_PAGE_SIZE },
  );
  const firstPagePending = status === "LoadingFirstPage";
  const loadMorePending = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="text-sm text-muted-foreground">
          Organizations and their wallet balances.
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
                <Table className="w-full text-sm">
                  <TableHeader>
                    <TableRow className="border-b text-left text-muted-foreground">
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Name
                      </TableHead>
                      <TableHead scope="col" className="px-2 py-2 font-medium">
                        Slug
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="px-2 py-2 font-medium text-right"
                      >
                        Balance
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((org) => (
                      <TableRow
                        key={org.handle}
                        className="border-b last:border-0"
                      >
                        <TableCell className="px-2 py-2.5 font-medium">
                          {org.name}
                        </TableCell>
                        <TableCell className="px-2 py-2.5 font-mono text-xs text-muted-foreground">
                          {org.slug}
                        </TableCell>
                        <TableCell className="px-2 py-2.5 text-right tabular-nums">
                          <Badge variant="secondary">
                            {formatCredits(org.balance)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {canLoadMore || loadMorePending ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadMorePending || !canLoadMore}
                    onClick={() => loadMore(ORG_PAGE_SIZE)}
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
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Building2 />
        </EmptyMedia>
        <EmptyTitle>No organizations</EmptyTitle>
        <EmptyDescription>
          Organizations appear here once their members sign in.
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
