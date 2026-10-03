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
    path?.match(/^\/app\/projects\/([a-z0-9-]+)$/)?.[1];
  const api = (path: string | undefined) =>
    path
      ?.match(/^\/catalogue\/([a-z0-9-]+)\/([a-z0-9-]+)$/)
      ?.slice(1)
      .join("/");
  const projectSlug =
    from === "/app/projects"
      ? project(to)
      : to === "/app/projects"
        ? project(from)
        : undefined;
  if (projectSlug && projectSlug !== "create") {
    return [direction, "nav-morph", `project-surface-${projectSlug}`];
  }
  const apiSlug =
    from === "/catalogue" || from === ""
      ? api(to)
      : to === "/catalogue" || to === ""
        ? api(from)
        : undefined;
  if (apiSlug) return [direction, "nav-morph", `api-surface-${apiSlug}`];
  return [direction, "nav-swap"];
}
