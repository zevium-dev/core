import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Flag, History, MessageSquareText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { Id } from "#/lib/convex-data-model";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { type ReviewQueueMode } from "#/lib/route-search";
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
  DialogClose,
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
import { Field, FieldLabel } from "#/components/ui/field";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Textarea } from "#/components/ui/textarea";

type ModerationTarget = {
  reviewId: Id<"reviews">;
  action: "hidden" | "restored";
  projectName: string;
  expectedModerationGeneration: number;
  expectedContentRevision: number;
};

const MODES: Array<{ value: ReviewQueueMode; label: string }> = [
  { value: "active", label: "Active" },
  { value: "hidden", label: "Hidden" },
  { value: "reported", label: "Reported" },
  { value: "history", label: "History" },
];
const MODERATION_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function AdminReviewsQueue({
  mode,
  onModeChange,
}: {
  mode: ReviewQueueMode;
  onModeChange: (mode: ReviewQueueMode) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<Array<string | null>>([]);
  const [target, setTarget] = useState<ModerationTarget | null>(null);
  const mutationErrorRef = useRef<HTMLParagraphElement>(null);
  const queueQuery = useQuery(
    convexQuery(api.reviews.listModerationQueue, {
      mode,
      limit: 20,
      ...(cursor === null ? {} : { cursor }),
    }),
  );
  const moderate = useConvexMutation(api.reviews.moderate);
  const moderation = useMutation({
    mutationFn: (input: ModerationTarget & { reason: string }) =>
      moderate({
        reviewId: input.reviewId,
        action: input.action,
        reason: input.reason,
        expectedModerationGeneration: input.expectedModerationGeneration,
        expectedContentRevision: input.expectedContentRevision,
      }),
    onSuccess: (_result, input) => {
      toast.success(
        input.action === "hidden" ? "Review hidden" : "Review restored",
      );
      setTarget(null);
    },
    onError: (error) =>
      toast.error(humanError(error, "Could not moderate review")),
  });
  useEffect(() => {
    if (moderation.error !== null) mutationErrorRef.current?.focus();
  }, [moderation.error]);

  const switchMode = (value: string) => {
    const next = MODES.find((entry) => entry.value === value)?.value;
    if (next === undefined) return;
    onModeChange(next);
    setCursor(null);
    setPrevious([]);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Review moderation
        </h1>
        <p className="text-sm text-muted-foreground">
          Inspect active, hidden, and reported verified reviews. Every hide and
          restore keeps reason.
        </p>
      </div>

      <Tabs value={mode} onValueChange={switchMode}>
        <TabsList
          className="h-auto w-full flex-wrap justify-start"
          aria-label="Review queue"
        >
          {MODES.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {queueQuery.isPending ? (
        <ReviewsQueueSkeleton />
      ) : queueQuery.isError ? (
        <Card>
          <CardContent
            className="flex flex-wrap items-center gap-2 pt-6"
            role="alert"
          >
            <span className="text-sm">
              Moderation queue could not be loaded.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queueQuery.refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : queueQuery.data.page.length === 0 ? (
        <ModerationQueueEmpty mode={mode} />
      ) : (
        <div className="space-y-3" aria-live="polite">
          {queueQuery.data.page.map((row, index) => {
            if (row.item === null) return null;
            const item = row.item;
            return (
              <Card key={`${row.kind}:${item.reviewId}:${index}`}>
                <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <CardTitle className="break-words text-base">
                      {item.projectName}
                    </CardTitle>
                    <CardDescription className="break-words">
                      {item.publisherName} · {item.rating}/5 · verified consumer
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={item.hidden ? "secondary" : "outline"}>
                      {item.hidden ? "Hidden" : "Active"}
                    </Badge>
                    {item.reportCount > 0 ? (
                      <Badge variant="secondary">
                        {item.reportCount} open report
                        {item.reportCount === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {item.body ?? "Rating only."}
                  </p>
                  {item.response ? (
                    <div className="rounded-md bg-muted p-3">
                      <p className="text-xs font-medium">Publisher response</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                        {item.response.body}
                      </p>
                    </div>
                  ) : null}
                  {item.reports.length > 0 ? (
                    <div className="space-y-2 rounded-md border p-3">
                      <p className="flex items-center gap-2 text-xs font-medium">
                        <Flag className="size-3.5" aria-hidden="true" /> Report
                        reasons
                      </p>
                      {item.reports.map((report) => (
                        <p
                          key={`${report.at}:${report.reason}`}
                          className="break-words text-sm text-muted-foreground"
                        >
                          {report.reason}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {row.kind === "history" ? (
                    <div className="rounded-md border p-3 text-sm">
                      <p className="font-medium capitalize">
                        {row.action.action}
                      </p>
                      <p className="break-words text-muted-foreground">
                        {row.action.reason}
                      </p>
                      <time
                        className="text-xs text-muted-foreground"
                        dateTime={new Date(row.action.at).toISOString()}
                      >
                        {MODERATION_DATE_FORMAT.format(row.action.at)} UTC
                      </time>
                    </div>
                  ) : item.latestAction ? (
                    <p className="text-xs text-muted-foreground">
                      Latest action: {item.latestAction.action} —{" "}
                      {item.latestAction.reason}
                    </p>
                  ) : null}
                  {row.kind !== "history" ? (
                    <Button
                      type="button"
                      variant={item.hidden ? "outline" : "destructive"}
                      onClick={() => {
                        moderation.reset();
                        setTarget({
                          reviewId: item.reviewId,
                          action: item.hidden ? "restored" : "hidden",
                          projectName: item.projectName,
                          expectedModerationGeneration:
                            item.expectedModerationGeneration,
                          expectedContentRevision: item.expectedContentRevision,
                        });
                      }}
                    >
                      {item.hidden ? "Restore review" : "Hide review"}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
          <nav
            className="flex flex-wrap justify-between gap-2"
            aria-label="Review queue pages"
          >
            <Button
              type="button"
              variant="outline"
              disabled={previous.length === 0}
              onClick={() => {
                const stack = previous.slice(0, -1);
                setCursor(previous[previous.length - 1] ?? null);
                setPrevious(stack);
              }}
            >
              Previous page
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={queueQuery.data.nextCursor === null}
              onClick={() => {
                setPrevious((stack) => [...stack, cursor]);
                setCursor(queueQuery.data.nextCursor);
              }}
            >
              Next page
            </Button>
          </nav>
        </div>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (target === null) return;
              moderation.mutate({
                ...target,
                reason: String(
                  new FormData(event.currentTarget).get("reason") ?? "",
                ),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {target?.action === "hidden" ? "Hide" : "Restore"} review?
              </DialogTitle>
              <DialogDescription>
                {target?.projectName}. Reason enters immutable moderation
                history.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="moderation-reason">Reason</FieldLabel>
              <Textarea
                id="moderation-reason"
                name="reason"
                required
                minLength={3}
                maxLength={1_000}
                aria-describedby={
                  moderation.error === null ? undefined : "moderation-error"
                }
              />
            </Field>
            {moderation.error !== null ? (
              <p
                id="moderation-error"
                ref={mutationErrorRef}
                role="alert"
                tabIndex={-1}
                className="text-sm text-destructive"
              >
                {humanError(moderation.error, "Could not moderate review")}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                variant={
                  target?.action === "hidden" ? "destructive" : "default"
                }
                disabled={moderation.isPending}
              >
                {moderation.isPending ? "Saving…" : "Confirm action"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ReviewsQueueSkeleton() {
  return (
    <div aria-label="Loading review moderation queue" className="space-y-3">
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-44 w-full" />
      ))}
    </div>
  );
}

export function ModerationQueueEmpty({ mode }: { mode: ReviewQueueMode }) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {mode === "history" ? <History /> : <MessageSquareText />}
        </EmptyMedia>
        <EmptyTitle>No {mode} reviews</EmptyTitle>
        <EmptyDescription>Queue is clear for this filter.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
