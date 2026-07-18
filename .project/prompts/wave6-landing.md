Task: landing page v2 — add scroll depth. Write scope: /home/tnfssc/Code/zevium/apps/web/src/routes/index.tsx, apps/web/src/components/ (public/landing components only; do not touch app shell/sidebar), apps/web/src/components/public-header.tsx.

Read first: AGENTS.md, PRODUCT.md (all copy sourced here — product language only), DESIGN.md (motion tokens, scroll reveals, reduced-motion), FLOW.md 1.1, current apps/web/src/routes/index.tsx.

KEEP: current hero + proof strip + compact vibe. ADD below the fold, in order:

1. "How it works" — 3 steps as horizontal cards: Publish an OpenAPI spec (pricing lives in the spec, x-zevium-cost) → Agents & devs discover and call through the metered gateway → Credits settle per call, publishers keep 95%. Structural numbering OK here (real sequence).
2. "For consumers" — org-scoped prepaid credits; zero balance blocks the call (never surprise overage); try-before-buy playground; one API key for every listed API.
3. "For publishers" — your spec is the contract AND the price sheet; immutable published versions; instant metering, no billing code; 95/5 split ($1 = 10,000 credits).
4. "For agents" — MCP endpoint + /discovery; include a small code block showing MCP config JSON (host from import.meta.env VITE_GATEWAY_URL fallback, NOT hardcoded prod). Monospace, copy button.
5. Live catalogue teasers section (already exists — relocate into this flow). Fix: FALLBACK_TEASERS when no public APIs must link to /catalogue (no dead cards).
6. Real footer: columns (Product: Catalogue, Pricing→/catalogue anchor; Publishers: Start publishing→/app/projects; Company: GitHub placeholder-free — only links that resolve). NO "Docs" link (docs site not built; adding dead link forbidden).

MOTION: scroll-triggered reveals with Motion (m.div whileInView, viewport once, using motion tokens from src/lib/motion.ts — durations/easings from CSS vars pattern used elsewhere). Respect prefers-reduced-motion (existing hook/pattern — check components). No hardcoded duration-300 classes. Semantic color tokens only.

Copy: terse, concrete, from PRODUCT.md. No lorem, no marketing fluff, no emojis.

TESTS: extract any non-trivial logic into testable helpers; if all presentational, state so in output. Root pnpm typecheck/build must stay green.

VERIFY: `pnpm --filter web typecheck && pnpm --filter web build` green.

Output: CHANGED list, VERIFY results, DONE or BLOCKED.
