import * as React from "react";

export const MOBILE_BREAKPOINT = 768;

export function getIsMobileFromWindow() {
  if (typeof window === "undefined") return false;

  if (typeof window.matchMedia === "function") {
    return window.matchMedia(getMobileMediaQuery()).matches;
  }

  if (typeof window.innerWidth === "number") {
    return window.innerWidth < MOBILE_BREAKPOINT;
  }

  return false;
}

export function useIsMobile() {
  // SSR-safe: uses server snapshot during hydration, then subscribes on client.
  return React.useSyncExternalStore(subscribeToIsMobile, getIsMobileFromWindow, () => false);
}

function getMobileMediaQuery() {
  return `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
}

function subscribeToIsMobile(callback: () => void) {
  if (typeof window === "undefined") return () => undefined;

  if (typeof window.matchMedia === "function") {
    const mql = window.matchMedia(getMobileMediaQuery());
    const onChange = () => callback();

    // addListener/removeListener are deprecated; fall back to window resize.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
  }

  const onResize = () => callback();
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
  };
}
