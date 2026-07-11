import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Banknote, Check, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import {
  buildOrgByClerkIdMap,
  orgDisplayNameByClerkId,
  type OrgByClerkIdMap,
} from "#/lib/admin-filters";
import { mergeUsagePages } from "#/lib/activity-filters";
import { api } from "#/lib/convex-api";
import type { Id } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { payoutStatusLabel, payoutStatusVariant } from "#/lib/payout-helpers";
import { formatCreditsAsUsd } from "#/lib/project-helpers";
import type { AdminPayoutRequestView } from "../../../../../convex/admin";

const REQUESTS_PAGE_SIZE = 25;
const ORG_MAP_PAGE_SIZE = 100;

type ResolveTarget = {
  request: AdminPayoutRequestView;
  status: "paid" | "rejected";
};

export const Route = createFileRoute("/admin/payouts")({
  component: AdminPayoutsPage,
  head: () => ({
    meta: [{ title: "Admin Payouts · Zevium" }],
  }),
  pendingComponent: PayoutsSkeleton,
});

function AdminPayoutsPage() {
  const orgMap = useOrgByClerkIdMap();

  const pending = usePayoutQueue("pending");
  const resolved = useResolvedPayouts();

  const [resolveTarget, setResolveTarget] = useState<ResolveTarget | null>(
    null,
  );
  const [note, setNote] = useState("");

  const resolveMutation = useConvexMutation(api.admin.resolvePayout);
  const { mutate: resolvePayout, isPending: resolvePending } = useMutation({
    mutationFn: (vars: {
      requestId: Id<"payoutRequests">;
      status: "paid" | "rejected";
      note?: string;
    }) => resolveMutation(vars),
    onSuccess: (_data, vars) => {
      toast.success(
        vars.status === "paid" ? "Marked paid." : "Request rejected.",
      );
      setResolveTarget(null);
      setNote("");
      pending.refresh();
      resolved.refresh();
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not resolve payout request."));
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payouts</h1>
        <p className="text-sm text-muted-foreground">
          Manual fulfilment queue. Publisher requests land here for a human to
          wire the money and mark them resolved.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Banknote className="size-4" />
            Pending queue
          </CardTitle>
          <CardDescription>
            Requests awaiting fulfilment, oldest first is not guaranteed —
            sorted newest-requested first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.firstPagePending ? (
            <PayoutsTableSkeleton />
          ) : pending.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No pending payout requests.
            </p>
          ) : (
            <PayoutsTable
              rows={pending.rows}
              orgMap={orgMap}
              canLoadMore={pending.canLoadMore}
              loadMorePending={pending.loadMorePending}
              onLoadMore={pending.loadMore}
              actions={(request) => (
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={resolvePending}
                    onClick={() =>
                      setResolveTarget({ request, status: "paid" })
                    }
                  >
                    <Check className="size-3" />
                    Mark paid
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={resolvePending}
                    onClick={() =>
                      setResolveTarget({ request, status: "rejected" })
                    }
                  >
                    <X className="size-3" />
                    Reject
                  </Button>
                </div>
              )}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resolved</CardTitle>
          <CardDescription>Paid and rejected requests.</CardDescription>
        </CardHeader>
        <CardContent>
          {resolved.firstPagePending ? (
            <PayoutsTableSkeleton />
          ) : resolved.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing resolved yet.
            </p>
          ) : (
            <PayoutsTable
              rows={resolved.rows}
              orgMap={orgMap}
              canLoadMore={resolved.canLoadMore}
              loadMorePending={resolved.loadMorePending}
              onLoadMore={resolved.loadMore}
            />
          )}
        </CardContent>
      </Card>

      <ResolveDialog
        target={resolveTarget}
        note={note}
        onNoteChange={setNote}
        pending={resolvePending}
        onCancel={() => {
          setResolveTarget(null);
          setNote("");
        }}
        onConfirm={() => {
          if (resolveTarget === null) return;
          resolvePayout({
            requestId: resolveTarget.request._id,
            status: resolveTarget.status,
            note: note.trim().length > 0 ? note.trim() : undefined,
          });
        }}
      />
    </div>
  );
}

function PayoutsTable({
  rows,
  orgMap,
  canLoadMore,
  loadMorePending,
  onLoadMore,
  actions,
}: {
  rows: AdminPayoutRequestView[];
  orgMap: OrgByClerkIdMap;
  canLoadMore: boolean;
  loadMorePending: boolean;
  onLoadMore: () => void;
  actions?: (request: AdminPayoutRequestView) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-2 py-2 font-medium">Org</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium text-right">Credits</th>
              <th className="px-2 py-2 font-medium text-right">USD</th>
              <th className="px-2 py-2 font-medium">Destination</th>
              <th className="px-2 py-2 font-medium">Age</th>
              {actions ? (
                <th className="px-2 py-2 font-medium text-right">Actions</th>
              ) : (
                <th className="px-2 py-2 font-medium">Note</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((request) => (
              <tr key={request._id} className="border-b last:border-0">
                <td className="px-2 py-2.5 font-medium">
                  {orgDisplayNameByClerkId(request.clerkOrgId, orgMap)}
                </td>
                <td className="px-2 py-2.5">
                  <Badge variant={payoutStatusVariant(request.status)}>
                    {payoutStatusLabel(request.status)}
                  </Badge>
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {request.credits.toLocaleString()}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                  {formatCreditsAsUsd(request.credits)}
                </td>
                <td className="max-w-[16rem] truncate px-2 py-2.5 text-muted-foreground">
                  {request.destination}
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">
                  {new Date(request.createdAt).toLocaleDateString()}
                </td>
                {actions ? (
                  <td className="px-2 py-2.5">{actions(request)}</td>
                ) : (
                  <td className="px-2 py-2.5 text-muted-foreground">
                    {request.note ?? "—"}
                  </td>
                )}
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
            onClick={onLoadMore}
          >
            {loadMorePending ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ResolveDialog({
  target,
  note,
  onNoteChange,
  pending,
  onCancel,
  onConfirm,
}: {
  target: ResolveTarget | null;
  note: string;
  onNoteChange: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const rejecting = target?.status === "rejected";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {rejecting ? "Reject payout request?" : "Mark payout paid?"}
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                {target.request.credits.toLocaleString()} credits (
                {formatCreditsAsUsd(target.request.credits)}) to{" "}
                <span className="font-mono text-xs">
                  {target.request.destination}
                </span>
                . This cannot be undone.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="resolve-note">Note (optional)</Label>
          <Textarea
            id="resolve-note"
            placeholder={
              rejecting ? "Reason for rejection" : "Transfer reference"
            }
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={rejecting ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Saving…" : rejecting ? "Reject" : "Mark paid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shared paginated-page accumulation for the pending / resolved queues. */
function usePayoutQueue(status: "pending" | "paid" | "rejected") {
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminPayoutRequestView[]>([]);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  const args = useMemo(
    () => ({
      status,
      paginationOpts: { numItems: REQUESTS_PAGE_SIZE, cursor },
    }),
    [status, cursor],
  );
  const query = useQuery(convexQuery(api.admin.listPayoutRequests, args));

  useEffect(() => {
    if (!query.data || query.isPending) return;
    setRows((prev) => mergeUsagePages(prev, query.data!.page, cursor === null));
    setIsDone(query.data.isDone);
    setContinueCursor(query.data.continueCursor);
  }, [query.data, query.isPending, cursor]);

  return {
    rows,
    firstPagePending: query.isPending && cursor === null,
    loadMorePending: query.isPending && cursor !== null,
    canLoadMore: !isDone && continueCursor !== null && !query.isPending,
    loadMore: () => {
      if (continueCursor !== null) setCursor(continueCursor);
    },
    refresh: () => {
      setCursor(null);
      setRows([]);
      setIsDone(false);
      setContinueCursor(null);
    },
  };
}

/** Resolved queue merges paid + rejected client-side (no composite index needed at this scale). */
function useResolvedPayouts() {
  const paid = usePayoutQueue("paid");
  const rejected = usePayoutQueue("rejected");

  const rows = useMemo(() => {
    return [...paid.rows, ...rejected.rows].sort(
      (a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0),
    );
  }, [paid.rows, rejected.rows]);

  return {
    rows,
    firstPagePending: paid.firstPagePending || rejected.firstPagePending,
    loadMorePending: paid.loadMorePending || rejected.loadMorePending,
    canLoadMore: paid.canLoadMore || rejected.canLoadMore,
    loadMore: () => {
      if (paid.canLoadMore) paid.loadMore();
      if (rejected.canLoadMore) rejected.loadMore();
    },
    refresh: () => {
      paid.refresh();
      rejected.refresh();
    },
  };
}

/**
 * Background clerkOrgId → name lookup, paged in fully (admin tool, bounded
 * scale). Mirrors admin/projects.tsx useOrgNameMap but keyed by clerkOrgId
 * since payout requests store the auth-mirror id, not the doc id.
 */
function useOrgByClerkIdMap() {
  const [orgs, setOrgs] = useState<
    { clerkOrgId: string; name: string; slug: string }[]
  >([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [continueCursor, setContinueCursor] = useState<string | null>(null);

  const args = useMemo(
    () => ({ paginationOpts: { numItems: ORG_MAP_PAGE_SIZE, cursor } }),
    [cursor],
  );
  const orgsQuery = useQuery(convexQuery(api.admin.listOrgs, args));

  useEffect(() => {
    if (!orgsQuery.data || orgsQuery.isPending) return;
    const incoming = orgsQuery.data.page.map((o) => ({
      clerkOrgId: o.clerkOrgId,
      name: o.name,
      slug: o.slug,
    }));
    setOrgs((prev) => {
      const base = cursor === null ? [] : prev;
      const seen = new Set(base.map((o) => o.clerkOrgId));
      const next = [...base];
      for (const org of incoming) {
        if (!seen.has(org.clerkOrgId)) {
          seen.add(org.clerkOrgId);
          next.push(org);
        }
      }
      return next;
    });
    setIsDone(orgsQuery.data.isDone);
    setContinueCursor(orgsQuery.data.continueCursor);
  }, [orgsQuery.data, orgsQuery.isPending, cursor]);

  useEffect(() => {
    if (isDone || orgsQuery.isPending) return;
    if (continueCursor !== null) setCursor(continueCursor);
  }, [isDone, continueCursor, orgsQuery.isPending]);

  return useMemo(() => buildOrgByClerkIdMap(orgs), [orgs]);
}

function PayoutsTableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="ml-auto h-6 w-32" />
        </div>
      ))}
    </div>
  );
}

function PayoutsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <PayoutsTableSkeleton />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent>
          <PayoutsTableSkeleton />
        </CardContent>
      </Card>
    </div>
  );
}
