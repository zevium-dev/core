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
  const isDetail = (path: string | undefined): boolean =>
    path !== undefined &&
    (/^\/app\/projects\/[^/]+/.test(path) ||
      /^\/catalogue\/[^/]+\/[^/]+/.test(path));

  return !isDetail(fromPath) && !isDetail(toPath)
    ? [direction, "nav-swap"]
    : [direction];
}
