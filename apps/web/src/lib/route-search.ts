import { z } from "zod";

export const REVIEW_QUEUE_MODES = [
  "active",
  "hidden",
  "reported",
  "history",
] as const;

export type ReviewQueueMode = (typeof REVIEW_QUEUE_MODES)[number];

export const reviewModerationSearchSchema = z.object({
  tab: z.enum(REVIEW_QUEUE_MODES).optional().catch(undefined),
});

export type ReviewModerationRouteSearch = z.infer<
  typeof reviewModerationSearchSchema
>;

export function reviewQueueMode(
  search: ReviewModerationRouteSearch,
): ReviewQueueMode {
  return search.tab ?? "reported";
}
