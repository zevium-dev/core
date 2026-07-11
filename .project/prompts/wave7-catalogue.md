Task: catalogue discovery upgrade — richer cards, filters/sort, env-driven MCP host.
Write scope: convex/catalogue.ts, apps/web/src/routes/catalogue/ ONLY. (You are the only lane touching convex/catalogue.ts.)

Read first: AGENTS.md, DESIGN.md, FLOW.md 1.2/1.3, PRODUCT.md pricing, convex/catalogue.ts, apps/web/src/routes/catalogue/index.tsx and $orgSlug.$projectSlug.tsx, packages/shared (parseSpec, extractPricing).

BUILD:

1. convex/catalogue.ts: enrich listPublic results with pricing summary computed from latest published specVersion at query time: {minCost, maxCost, endpointCount, hasFreeTier}. Parse via @zevium/shared (workspace dep already wired for convex). Keep index usage; this is a public unauthenticated query — never expose drafts or private projects. Add args: sort ("newest"|"name"|"cheapest"), hasFreeTier filter, maxCost filter. Add convex tests (convex/catalogue.test.ts — follow existing convex-test setup from usage.test.ts) covering: private/draft exclusion, pricing summary math, filters, sort.
2. Catalogue index UI: price range badge on cards ("1–8 cr/call"), free-tier badge, endpoint count; sort select + free-tier toggle + max-cost input wired to query args; keep substring search (semantic search = wave 8, do not build).
3. API detail: replace hardcoded https://gateway.zevium.dev/mcp with env-driven base (VITE_GATEWAY_URL fallback localhost:8787 — same pattern as apps/web/src/lib/landing.ts helpers; reuse that module if importable).
4. Keep playground/try-it untouched.

RULES: stock shadcn, semantic tokens, motion tokens, skeletons, no table scans in convex hot paths (listPublic bounded — cap page size), never trust client identifiers.

TESTS: convex/catalogue.test.ts (above) + any web pure helpers tested.

VERIFY: pnpm typecheck && pnpm test && pnpm --filter web build green, npx convex dev --once clean.
Output: CHANGED list, VERIFY results, DONE or BLOCKED.
