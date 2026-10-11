/** Preview-only pairing. Production remains legacy until PR 7. */
export const NEXT_CONTROL_PLANE =
  import.meta.env.VITE_CONTROL_PLANE_MODE === "next";
export function convexUrl(): string {
  const url = NEXT_CONTROL_PLANE
    ? import.meta.env.VITE_NEXT_CONVEX_URL
    : import.meta.env.VITE_CONVEX_URL;
  if (NEXT_CONTROL_PLANE && !url)
    throw new Error("Application connection is not configured");
  return url ?? "";
}
