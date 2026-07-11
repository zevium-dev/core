# Backlog — user-requested (2026-07-11)

## 1. Landing page v2 (noted, not started)

Current compact layout stays as vibe, but page needs scroll depth:

- scrolling sections below fold: what Zevium does, feature breakdown (metered gateway, MCP/agent endpoint, publisher 95% split, org credits, spec-as-pricing)
- keep current density; add narrative sections, not marketing bloat
- DESIGN.md motion rules apply (scroll-driven reveals must respect prefers-reduced-motion)

## 2. /app navigation sluggish (investigating)

Symptom: click sidebar link → URL changes instantly → UI stalls before render.
Suspects: route loaders awaiting Convex round-trips without preload, missing
`defaultPreload: 'intent'`, no `pendingComponent`/`defaultPendingMs`, SSR re-fetch.

## 3. Publisher spec-creation UX overhaul (discovery phase)

Current experience not good enough. Do discovery → mockup options → user picks direction.

## 4. Placeholder audit

Settings page is placeholder. Sweep whole app for placeholder/TODO/stub screens;
complete everything. Collect open questions needing user input.
