WAVE 3 — WEB: CATALOGUE + API DETAIL + PLAYGROUND. Project: /home/tnfssc/Code/zevium. Read AGENTS.md, FLOW.md §1.2/1.3/2, DESIGN.md, existing apps/web + convex/catalogue.ts. Edit ONLY apps/web/.

1. /catalogue (PUBLIC, SSR — loader ensureQueryData so listing names appear in server HTML; verify pattern already wired in router): search input (debounced, plain LIKE param for now), tag chips, card grid (name, org, description, price range chip parsed from... catalogue query returns priceRange — if not, compute client-side from detail later; keep card fields to what query provides). Cards link → /catalogue/$orgSlug/$projectSlug with view-transition-name api-title-{slug} morph.
2. /catalogue/$orgSlug/$projectSlug (PUBLIC, SSR): header (name, org, tags), pricing table per endpoint (parse published spec client-side with @zevium/shared parseSpec — pnpm add workspace dep), docs: endpoint list with method badges + summaries + per-endpoint credits; Try-it panel: select endpoint, path params inputs, headers/body textarea (for POST), API key input (session-storage only, loud "real call, charged" notice), Send → fetch to gateway URL (env VITE_GATEWAY_URL default http://localhost:8787/gateway) → show status + timing + response body (mono, scrollable). Copy-as-curl button.
3. "Connect your agent" tab: static MCP config snippet block with copy (placeholder endpoint URL) per FLOW.md 1.3.
4. Empty/skeleton states layout-stable; motions from motion.ts only.
5. `pnpm --filter web build` + typecheck green.

End with `DONE:` or `BLOCKED:`.
