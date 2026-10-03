import type { AnyRouter } from "@tanstack/react-router";

import { prefersReducedMotion } from "./view-transition";

/** Entrances must render their final state into a navigation snapshot. */
export const vtState = { active: false };

let currentTransition: object | undefined;

function selectSharedSurface(surface: string | undefined): boolean {
  for (const element of document.querySelectorAll(
    "[data-view-transition-shared]",
  )) {
    element.removeAttribute("data-view-transition-shared");
  }
  if (!surface) return false;
  const element = Array.from(
    document.querySelectorAll<HTMLElement>("[data-transition-surface]"),
  ).find((candidate) => candidate.dataset.transitionSurface === surface);
  if (!element) return false;
  element.dataset.viewTransitionShared = "";
  return true;
}

export function runViewTransition(
  update: () => Promise<void>,
  types: string[] | false,
): Promise<void> {
  if (
    types === false ||
    prefersReducedMotion() ||
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function"
  ) {
    return update();
  }

  const owner = {};
  currentTransition = owner;
  vtState.active = true;
  document.documentElement.dataset.viewTransition = "active";
  const surface = types.find((type) => /^(project|api)-surface-/.test(type));
  const hasSource = selectSharedSurface(surface);
  document.documentElement.dataset.viewTransitionKind = hasSource
    ? "morph"
    : "swap";
  document.documentElement.dataset.viewTransitionDirection = types.includes(
    "navigate-back",
  )
    ? "back"
    : "forward";

  const captureDestination = async () => {
    await update();
    if (currentTransition !== owner) return;
    const hasDestination = selectSharedSurface(hasSource ? surface : undefined);
    document.documentElement.dataset.viewTransitionKind = hasDestination
      ? "morph"
      : "swap";
  };

  const clear = () => {
    // A skipped older transition can finish after a newer one has started.
    if (currentTransition !== owner) return;
    currentTransition = undefined;
    vtState.active = false;
    delete document.documentElement.dataset.viewTransition;
    delete document.documentElement.dataset.viewTransitionKind;
    delete document.documentElement.dataset.viewTransitionDirection;
    selectSharedSurface(undefined);
  };

  try {
    const transition = window.CSS?.supports?.(
      "selector(:active-view-transition-type(a))",
    )
      ? document.startViewTransition({ update: captureDestination, types })
      : document.startViewTransition(captureDestination);

    // ready rejects when a snapshot is skipped (for example on rapid clicks).
    // Navigation still succeeds; only an update failure should reach the router.
    void transition.ready.catch(() => undefined);
    void transition.finished.then(clear, clear);
    return transition.updateCallbackDone;
  } catch {
    clear();
    // Unsupported browser variants must never prevent navigation.
    return update();
  }
}

/**
 * TanStack currently discards the native transition handle and only evaluates
 * its types callback in browsers with type support. Keep the handle so cleanup
 * follows finished, and apply our policy in both browser paths.
 */
export function configureViewTransitions(router: AnyRouter): void {
  router.startViewTransition = (update) => {
    const options =
      router.shouldViewTransition ?? router.options.defaultViewTransition;
    router.shouldViewTransition = undefined;

    const toLocation = router.latestLocation;
    const fromLocation = router.state.resolvedLocation;
    if (fromLocation && typeof document !== "undefined") {
      // Persistent: removing this after finished would restart CSS entrances.
      document.documentElement.dataset.navigation = "client";
    }
    const types =
      typeof options === "object"
        ? typeof options.types === "function"
          ? options.types({
              fromLocation,
              toLocation,
              pathChanged: fromLocation?.pathname !== toLocation.pathname,
              hrefChanged: fromLocation?.href !== toLocation.href,
              hashChanged: fromLocation?.hash !== toLocation.hash,
            })
          : options.types
        : options
          ? []
          : false;

    return runViewTransition(update, types);
  };
}
