/**
 * Module-level VT coordination flag.
 * Set synchronously in router defaultViewTransition.types callback.
 * Cleared on viewtransitionend (600ms fallback).
 * Motion components read this so entrance animations never render
 * opacity:0 into the new-state VT snapshot.
 */
export const vtState = {
  active: false,
};

let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function markViewTransitionActive() {
  vtState.active = true;
  if (typeof document === "undefined") return;

  if (clearTimer !== undefined) {
    clearTimeout(clearTimer);
    clearTimer = undefined;
  }

  const clear = () => {
    vtState.active = false;
    document.removeEventListener("viewtransitionend", clear);
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  };

  document.addEventListener("viewtransitionend", clear, { once: true });
  clearTimer = setTimeout(clear, 600);
}
