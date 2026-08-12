import { MAX_ENDPOINT_COST_CREDITS } from "@zevium/shared";
import { z } from "zod";

const optionalBoundedString = (maxLength: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value : undefined),
    z.string().max(maxLength).optional().catch(undefined),
  );

const optionalTrue = z.preprocess(
  (value) =>
    value === true || value === 1 || value === "1" ? true : undefined,
  z.literal(true).optional(),
);

const optionalCatalogueMax = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value))
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_ENDPOINT_COST_CREDITS
    ? parsed
    : undefined;
}, z.number().int().safe().min(0).max(MAX_ENDPOINT_COST_CREDITS).optional());

export const catalogueSearchSchema = z.object({
  q: optionalBoundedString(200),
  tag: optionalBoundedString(64),
  sort: z.enum(["name", "cheapest"]).optional().catch(undefined),
  free: optionalTrue,
  semantic: optionalTrue,
  max: optionalCatalogueMax,
});

export type CatalogueRouteSearch = z.infer<typeof catalogueSearchSchema>;

export function parseCatalogueMaxInput(
  value: string,
): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed <= MAX_ENDPOINT_COST_CREDITS
    ? parsed
    : undefined;
}

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
