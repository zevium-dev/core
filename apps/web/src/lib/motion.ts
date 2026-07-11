// src/lib/motion.ts — the only place these values live
export const EASE = [0.16, 1, 0.3, 1] as const; // ease-out-expo-ish. THE easing.

export const DUR = {
  instant: 0.15, // hover/press feedback, toggles
  fast: 0.25, // dropdowns, tooltips, tab switches, list item enter
  base: 0.35, // dialogs, sheets, popovers, card enter
  page: 0.4, // view transitions, route-level enter
  slow: 0.6, // scroll-reveals on landing, hero entrances (marketing only)
} as const;

export const STAGGER = 0.05; // list children; 0.025 for per-character effects
export const DIST = 16; // px translate for enters (24 on landing hero)

export const SPRING = {
  cursor: { stiffness: 250, damping: 18, mass: 0.4 }, // magnetic/trailing effects
  scroll: { stiffness: 120, damping: 30, mass: 0.4 }, // scroll-linked progress
  pop: { type: "spring" as const, stiffness: 350, damping: 14 }, // badge/stat pop-in
};
