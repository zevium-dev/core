import { ListBoundary } from "#/components/list-boundary";
import { formatMoney } from "#/lib/format";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "#/components/ui/table";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { usePaginatedQuery, useAction } from "convex/react";
import { AlertTriangle, RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import {
  moneyMovementFailure,
  moneyMovementStatusLabel,
  moneyMovementStatusVariant,
  operatorTransferAction,
} from "#/lib/stripe-ui";

type TransferStatus =
  "created" | "pending" | "succeeded" | "failed" | "reversed";
type TransferFilter = "all" | TransferStatus;
type PayoutsSearch = { status?: TransferStatus };
type PublisherTransfer = {
  id: Id<"publisherTransfers">;
  publisherOrganizationId: string;
  publisherOrganizationName: string;
  publisherOrganizationSlug?: string;
  stripeConnectedAccountId: string;
  amount: number;
  currency: string;
  status: TransferStatus;
  failureReason?: string;
  stripeTransferId?: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
};

const PAGE_SIZE = 25;
const FILTERS: readonly TransferFilter[] = [
  "all",
  "created",
  "pending",
  "succeeded",
  "failed",
  "reversed",
];

export const Route = createFileRoute("/admin/payouts")({
  validateSearch: (search: Record<string, unknown>): PayoutsSearch =>
    search.status === "created" ||
    search.status === "pending" ||
    search.status === "succeeded" ||
    search.status === "failed" ||
    search.status === "reversed"
      ? { status: search.status }
      : {},
  component: () => (
    <ListBoundary label="transfers">
      <AdminPayoutsPage />
    </ListBoundary>
  ),
  head: () => ({
    meta: [{ title: "Admin Transfers · Zevium" }],
  }),
  pendingComponent: PayoutsSkeleton,
});

function AdminPayoutsPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate();
  const filter: TransferFilter = status ?? "all";
  const [retryTarget, setRetryTarget] = useState<PublisherTransfer | null>(
    null,
  );
  const {
    results: rows,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.admin.listPublisherTransfers,
    filter === "all" ? {} : { status: filter },
    { initialNumItems: PAGE_SIZE },
  );

  const retryPublisherTransfer = useAction(api.admin.retryPublisherTransfer);
  const { mutate: retryTransfer, isPending: retryPending } = useMutation({
    mutationFn: (transferId: Id<"publisherTransfers">) =>
      retryPublisherTransfer({ transferId }),
    onSuccess: () => {
      toast.success(
        "Transfer retry requested using the original transfer reference.",
      );
      setRetryTarget(null);
    },
    onError: (error: unknown) => {
      toast.error(humanError(error, "Could not retry this Stripe transfer."));
    },
  });

  const firstPagePending = paginationStatus === "LoadingFirstPage";
  const loadMorePending = paginationStatus === "LoadingMore";
  const canLoadMore = paginationStatus === "CanLoadMore";

  function selectFilter(nextFilter: TransferFilter) {
    if (nextFilter === filter) return;
    void navigate({
      to: "/admin/payouts",
      search: nextFilter === "all" ? {} : { status: nextFilter },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Publisher transfers
        </h1>
        <p className="text-sm text-muted-foreground">
          Review transfers from Zevium to publisher Stripe accounts. Retry only
          failed transfers.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="size-4" />
            Transfer operations
          </CardTitle>
          <CardDescription>
            Filter by status or retry a failed transfer without creating a
            duplicate payment.
          </CardDescription>
          <div className="flex flex-wrap gap-2 pt-2">
            {FILTERS.map((status) => (
              <Button
                key={status}
                size="sm"
                variant={filter === status ? "default" : "outline"}
                onClick={() => selectFilter(status)}
              >
                {status === "all" ? "All" : moneyMovementStatusLabel(status)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {firstPagePending ? (
            <TransferTableSkeleton />
          ) : rows.length === 0 ? (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Send />
                </EmptyMedia>
                <EmptyTitle>No transfers</EmptyTitle>
                <EmptyDescription>
                  No {filter === "all" ? "publisher" : filter} transfers match
                  this filter.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <TransferTable
              rows={rows}
              retryPending={retryPending}
              onRetry={setRetryTarget}
            />
          )}
          {canLoadMore || loadMorePending ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadMorePending || !canLoadMore}
                onClick={() => loadMore(PAGE_SIZE)}
              >
                {loadMorePending ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <RetryTransferDialog
        target={retryTarget}
        pending={retryPending}
        onCancel={() => setRetryTarget(null)}
        onConfirm={() => {
          if (retryTarget) retryTransfer(retryTarget.id);
        }}
      />
    </div>
  );
}

function TransferTable({
  rows,
  retryPending,
  onRetry,
}: {
  rows: PublisherTransfer[];
  retryPending: boolean;
  onRetry: (transfer: PublisherTransfer) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b text-left text-muted-foreground">
            <TableHead scope="col" className="px-2 py-2 font-medium">
              Publisher organization
            </TableHead>
            <TableHead scope="col" className="px-2 py-2 font-medium">
              Status
            </TableHead>
            <TableHead scope="col" className="px-2 py-2 font-medium text-right">
              Amount
            </TableHead>
            <TableHead
              scope="col"
              className="hidden px-2 py-2 font-medium lg:table-cell"
            >
              Stripe transfer
            </TableHead>
            <TableHead
              scope="col"
              className="hidden px-2 py-2 font-medium md:table-cell"
            >
              Details
            </TableHead>
            <TableHead scope="col" className="px-2 py-2 font-medium text-right">
              Action
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((transfer) => {
            const retry = operatorTransferAction(transfer.status);
            const failure = moneyMovementFailure(
              transfer.status,
              transfer.failureReason,
            );
            return (
              <TableRow key={transfer.id} className="border-b last:border-0">
                <TableCell className="max-w-52 px-2 py-2.5">
                  <span className="block truncate font-medium">
                    {transfer.publisherOrganizationName}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {transfer.publisherOrganizationSlug ??
                      transfer.publisherOrganizationId}
                  </span>
                </TableCell>
                <TableCell className="px-2 py-2.5">
                  <Badge variant={moneyMovementStatusVariant(transfer.status)}>
                    {moneyMovementStatusLabel(transfer.status)}
                  </Badge>
                </TableCell>
                <TableCell className="px-2 py-2.5 text-right tabular-nums">
                  {formatMoney(transfer.amount, transfer.currency)}
                </TableCell>
                <TableCell className="hidden max-w-48 truncate px-2 py-2.5 font-mono text-xs text-muted-foreground lg:table-cell">
                  {transfer.stripeTransferId ?? "—"}
                </TableCell>
                <TableCell className="hidden max-w-64 truncate px-2 py-2.5 text-muted-foreground md:table-cell">
                  {failure ?? "—"}
                </TableCell>
                <TableCell className="px-2 py-2.5 text-right">
                  {retry.action && retry.label ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={retryPending}
                      onClick={() => onRetry(transfer)}
                    >
                      <RefreshCw className="size-3" />
                      {retry.label}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function RetryTransferDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: PublisherTransfer | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const action = target ? operatorTransferAction(target.status) : null;
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Retry Stripe transfer?</DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                {formatMoney(target.amount, target.currency)} for publisher{" "}
                <span className="font-mono text-xs">
                  {target.publisherOrganizationId}
                </span>
                . {action?.confirmation}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          Retry does not mark the transfer paid. Stripe events determine the
          final transfer state.
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Requesting retry…" : "Retry transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferTableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="ml-auto h-6 w-28" />
        </div>
      ))}
    </div>
  );
}

function PayoutsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <TransferTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}
