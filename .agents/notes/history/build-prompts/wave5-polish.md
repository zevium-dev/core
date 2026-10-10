WAVE 5 — POLISH LANE (motion + visual debt). Project: /home/tnfssc/Code/zevium. Read AGENTS.md, DESIGN.md (fully — motion tokens, view transitions, micro-interactions, delight budget), FLOW.md §1.1, .project/findings/visual-review-1.md. Edit ONLY apps/web/. Dev server on :3000 running — do NOT restart. `agent-browser` installed; verify visually as you go (screenshot both themes).

1. Session-aware public header (landing + catalogue): signed-out = Sign in button; signed-in = Dashboard link + Clerk UserButton. Use Clerk's SignedIn/SignedOut components. No layout shift between states (reserve space).
2. Landing hero per FLOW.md 1.1: right half currently empty — add catalogue teaser/proof strip (3 mini API cards or stat row — pull real data via catalogue.listPublic, fallback static). Stagger entrance (motion, tokens from src/lib/motion.ts), magnetic hover CTA per DESIGN.md delight budget. Respect prefers-reduced-motion.
3. View-transition audit: every list→detail nav (projects list→detail, catalogue→API detail) has a morph (vt name on shared element) or a code comment why not. Verify catalogue card→detail morph works (routes exist from catalogue lane).
4. Micro-interactions pass per DESIGN.md: buttons press-scale, cards hover-lift, skeleton→content crossfade, toast entrances. ALL values from motion.ts / CSS vars — hardcoded durations are a reject.
5. Reduced-motion: every animated component honors prefers-reduced-motion (kill transforms, keep opacity).
6. `pnpm --filter web build` + typecheck green. Screenshot landing (both themes), catalogue, dashboard — confirm no regressions.

End with `DONE: <what shipped + screenshots taken>` or `BLOCKED:`.
