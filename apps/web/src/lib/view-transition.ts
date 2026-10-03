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
  const project = (path: string | undefined) =>
    path?.match(/^\/app\/projects\/(?!create(?:\/|$))([^/]+)(?:\/spec)?$/)?.[1];
  const catalogue = (path: string | undefined) =>
    path?.match(/^\/catalogue\/[^/]+\/[^/]+$/);
  const related =
    (from === "/catalogue" && catalogue(to)) ||
    (to === "/catalogue" && catalogue(from)) ||
    (from === "/app/projects" && project(to)) ||
    (to === "/app/projects" && project(from)) ||
    (project(from) && project(from) === project(to));

  return related ? [direction] : [direction, "nav-swap"];
}
