import { convexQuery, useConvexMutation } from "@convex-dev/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePaginatedQuery } from "convex/react";
import { Star } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import type { Id } from "../../../../convex/_generated/dataModel";
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
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field";
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";

const REVIEW_PAGE_SIZE = 10;
const REVIEW_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function Stars({ rating }: { rating: number }) {
  return (
    <span
      className="inline-flex gap-0.5 text-foreground"
      aria-label={`${rating} out of 5 stars`}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          key={index}
          aria-hidden="true"
          className={index < rating ? "size-4 fill-current" : "size-4"}
        />
      ))}
    </span>
  );
}

export function ReviewSection({ projectId }: { projectId: Id<"projects"> }) {
  const aggregateQuery = useQuery(
    convexQuery(api.reviews.getAggregate, { projectId }),
  );
  const viewerQuery = useQuery(
    convexQuery(api.reviews.getViewerState, { projectId }),
  );
  const reviewsQuery = usePaginatedQuery(
    api.reviews.listPublicPaginated,
    { projectId },
    { initialNumItems: REVIEW_PAGE_SIZE },
  );

  const upsertReview = useConvexMutation(api.reviews.upsert);
  const withdrawReview = useConvexMutation(api.reviews.withdraw);
  const reportReview = useConvexMutation(api.reviews.report);
  const respond = useConvexMutation(api.reviews.respondAsPublisher);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [reporting, setReporting] = useState<Id<"reviews"> | null>(null);
  const actionErrorRef = useRef<HTMLParagraphElement>(null);
  const withdrawErrorRef = useRef<HTMLParagraphElement>(null);
  const reportErrorRef = useRef<HTMLParagraphElement>(null);

  const saveMutation = useMutation({
    mutationFn: (input: { rating: number; body?: string }) =>
      upsertReview({ projectId, ...input }),
    onSuccess: () => toast.success("Verified review saved"),
    onError: (error) => toast.error(humanError(error, "Could not save review")),
  });
  const withdrawMutation = useMutation({
    mutationFn: () => withdrawReview({ projectId }),
    onSuccess: () => {
      setWithdrawOpen(false);
      toast.success("Review withdrawn");
    },
    onError: (error) =>
      toast.error(humanError(error, "Could not withdraw review")),
  });
  const reportMutation = useMutation({
    mutationFn: (input: { reviewId: Id<"reviews">; reason: string }) =>
      reportReview(input),
    onSuccess: (result) => {
      setReporting(null);
      toast.success(
        result.reported ? "Review reported" : "Report already open",
      );
    },
    onError: (error) =>
      toast.error(humanError(error, "Could not report review")),
  });
  const responseMutation = useMutation({
    mutationFn: (input: { reviewId: Id<"reviews">; body: string }) =>
      respond(input),
    onSuccess: () => toast.success("Publisher response saved"),
    onError: (error) =>
      toast.error(humanError(error, "Could not save response")),
  });

  const viewer = viewerQuery.data;
  const ownReview = viewer?.review ?? null;
  const reviews = reviewsQuery.results;
  const actionError = saveMutation.error ?? responseMutation.error;
  useEffect(() => {
    if (actionError !== null) actionErrorRef.current?.focus();
  }, [actionError]);
  useEffect(() => {
    if (withdrawMutation.error !== null) withdrawErrorRef.current?.focus();
  }, [withdrawMutation.error]);
  useEffect(() => {
    if (reportMutation.error !== null) reportErrorRef.current?.focus();
  }, [reportMutation.error]);

  const submitReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body") ?? "").trim();
    saveMutation.mutate({
      rating: Number(form.get("rating")),
      ...(body === "" ? {} : { body }),
    });
  };

  return (
    <section className="space-y-4" aria-labelledby="reviews-heading">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle id="reviews-heading" className="text-base">
                Verified consumer reviews
              </CardTitle>
              <CardDescription>
                Only organizations with a settled gateway call can publish one
                review. Buyer identity remains private.
              </CardDescription>
            </div>
            {aggregateQuery.isPending ? (
              <Skeleton className="h-6 w-28" />
            ) : aggregateQuery.isError ? (
              <div role="alert" className="flex items-center gap-2 text-sm">
                Rating unavailable.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void aggregateQuery.refetch()}
                >
                  Retry rating
                </Button>
              </div>
            ) : aggregateQuery.data.count === 0 ? (
              <Badge variant="outline">Insufficient review data</Badge>
            ) : (
              <Badge variant="secondary" className="gap-2">
                <Stars
                  rating={Math.round(aggregateQuery.data.averageRating!)}
                />
                <span className="tabular-nums">
                  {aggregateQuery.data.averageRating?.toFixed(2)} ·{" "}
                  {aggregateQuery.data.count}
                </span>
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {viewerQuery.isPending ? (
            <ReviewFormSkeleton />
          ) : viewerQuery.isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 text-sm text-destructive"
            >
              Review eligibility could not be loaded.
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void viewerQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : viewer?.canReview ? (
            <form
              key={`${ownReview?._id ?? "new"}:${ownReview?.updatedAt ?? 0}`}
              className="space-y-4 rounded-lg border p-4"
              onSubmit={submitReview}
            >
              <div>
                <p className="font-medium">
                  {ownReview?.active ? "Edit your review" : "Write your review"}
                </p>
                <p className="text-sm text-muted-foreground">{viewer.reason}</p>
                {ownReview?.hidden ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    This review is hidden pending moderation. Edits remain
                    hidden.
                  </p>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field>
                  <FieldLabel htmlFor="review-rating">Rating</FieldLabel>
                  <select
                    id="review-rating"
                    name="rating"
                    defaultValue={String(ownReview?.rating ?? 5)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {[5, 4, 3, 2, 1].map((rating) => (
                      <option key={rating} value={rating}>
                        {rating} {rating === 1 ? "star" : "stars"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="review-body">Review</FieldLabel>
                  <Textarea
                    id="review-body"
                    name="body"
                    maxLength={2_000}
                    defaultValue={ownReview?.body ?? ""}
                    placeholder="What worked? What should other consumers know?"
                    aria-describedby={
                      saveMutation.error === null
                        ? undefined
                        : "review-action-error"
                    }
                  />
                  <FieldDescription>
                    Optional, up to 2,000 characters.
                  </FieldDescription>
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending
                    ? "Saving…"
                    : ownReview?.active
                      ? "Save changes"
                      : "Publish review"}
                </Button>
                {ownReview?.active ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      withdrawMutation.reset();
                      setWithdrawOpen(true);
                    }}
                    aria-describedby={
                      withdrawMutation.error === null
                        ? undefined
                        : "withdraw-review-error"
                    }
                  >
                    Withdraw
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{viewer?.reason}</p>
          )}

          {actionError ? (
            <p
              id="review-action-error"
              ref={actionErrorRef}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none"
            >
              {humanError(actionError, "Review action failed")}
            </p>
          ) : null}

          <div aria-live="polite">
            {reviewsQuery.status === "LoadingFirstPage" ? (
              <ReviewListSkeleton />
            ) : reviews.length === 0 ? (
              <ReviewEmptyState />
            ) : (
              <div className="space-y-3">
                {reviews.map((review) => (
                  <article key={review.id} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Stars rating={review.rating} />
                        <Badge variant="outline">{review.reviewerLabel}</Badge>
                      </div>
                      <time
                        dateTime={new Date(review.createdAt).toISOString()}
                        className="text-xs text-muted-foreground"
                      >
                        {REVIEW_DATE_FORMAT.format(review.createdAt)}
                      </time>
                    </div>
                    {review.body ? (
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                        {review.body}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-muted-foreground">
                        Rating only.
                      </p>
                    )}
                    {review.response ? (
                      <div className="mt-3 rounded-md bg-muted p-3">
                        <p className="text-xs font-medium">
                          Publisher response
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                          {review.response.body}
                        </p>
                      </div>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {viewer?.isPublisher ? (
                        <form
                          className="flex w-full flex-col gap-2 sm:flex-row"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const body = String(
                              new FormData(event.currentTarget).get(
                                "response",
                              ) ?? "",
                            );
                            responseMutation.mutate({
                              reviewId: review.id as Id<"reviews">,
                              body,
                            });
                          }}
                        >
                          <Field className="flex-1">
                            <FieldLabel htmlFor={`response-${review.id}`}>
                              Publisher response
                            </FieldLabel>
                            <Textarea
                              id={`response-${review.id}`}
                              name="response"
                              maxLength={2_000}
                              defaultValue={review.response?.body ?? ""}
                              aria-describedby={
                                responseMutation.error === null
                                  ? undefined
                                  : "review-action-error"
                              }
                            />
                          </Field>
                          <Button
                            type="submit"
                            variant="outline"
                            className="sm:self-end"
                            disabled={responseMutation.isPending}
                          >
                            Save response
                          </Button>
                        </form>
                      ) : viewer?.signedIn && ownReview?._id !== review.id ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            reportMutation.reset();
                            setReporting(review.id as Id<"reviews">);
                          }}
                        >
                          Report review
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
                {reviewsQuery.status === "CanLoadMore" ||
                reviewsQuery.status === "LoadingMore" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={reviewsQuery.status === "LoadingMore"}
                    onClick={() => reviewsQuery.loadMore(REVIEW_PAGE_SIZE)}
                  >
                    {reviewsQuery.status === "LoadingMore"
                      ? "Loading more…"
                      : "Load more reviews"}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw review?</DialogTitle>
            <DialogDescription>
              Review leaves public aggregate. You can reactivate it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={withdrawMutation.isPending}
              onClick={() => withdrawMutation.mutate()}
              aria-describedby={
                withdrawMutation.error === null
                  ? undefined
                  : "withdraw-review-error"
              }
            >
              {withdrawMutation.isPending ? "Withdrawing…" : "Withdraw review"}
            </Button>
          </DialogFooter>
          {withdrawMutation.error !== null ? (
            <p
              id="withdraw-review-error"
              ref={withdrawErrorRef}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none"
            >
              {humanError(withdrawMutation.error, "Could not withdraw review")}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={reporting !== null}
        onOpenChange={(open) => !open && setReporting(null)}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (reporting === null) return;
              reportMutation.mutate({
                reviewId: reporting,
                reason: String(
                  new FormData(event.currentTarget).get("reason") ?? "",
                ),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Report review</DialogTitle>
              <DialogDescription>
                Explain policy concern. Staff sees reason; reviewer identity
                stays private.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="report-reason">Reason</FieldLabel>
              <Textarea
                id="report-reason"
                name="reason"
                required
                minLength={10}
                maxLength={1_000}
                aria-describedby={
                  reportMutation.error === null ? undefined : "report-error"
                }
              />
            </Field>
            {reportMutation.error !== null ? (
              <p
                id="report-error"
                ref={reportErrorRef}
                role="alert"
                tabIndex={-1}
                className="text-sm text-destructive outline-none"
              >
                {humanError(reportMutation.error, "Could not report review")}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={reportMutation.isPending}>
                {reportMutation.isPending ? "Submitting…" : "Submit report"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function ReviewFormSkeleton() {
  return (
    <div
      aria-label="Loading review eligibility"
      className="space-y-3 rounded-lg border p-4"
    >
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function ReviewListSkeleton() {
  return (
    <div aria-label="Loading reviews" className="space-y-3">
      {[0, 1].map((row) => (
        <Skeleton key={row} className="h-28 w-full" />
      ))}
    </div>
  );
}

export function ReviewEmptyState() {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Star />
        </EmptyMedia>
        <EmptyTitle>No verified reviews yet</EmptyTitle>
        <EmptyDescription>
          Rating stays unscored until eligible consumers contribute.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
