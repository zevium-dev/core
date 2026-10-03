export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function routeViewTransitionTypes({
  fromIndex,
  toIndex,
  fromPath,
  toPath,
}: {
  fromIndex: number;
  toIndex: number;
  fromPath?: string;
  toPath: string;
}): string[] | false {
  if (prefersReducedMotion()) return false;

  const direction = toIndex >= fromIndex ? "navigate-forward" : "navigate-back";
  const normalize = (path: string | undefined) => path?.replace(/\/$/, "");
  const from = normalize(fromPath);
  const to = normalize(toPath);
  // Clerk profile hashes and same-page controls own their local transitions.
  if (from === to) return false;
  // Capture one complete page surface. Extracting card titles and badges made
  // list/detail navigation move fragments independently from their content.
  return [direction, "nav-swap"];
}
