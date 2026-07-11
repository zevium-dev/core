Task: catalogue semantic search via Convex vector search + Gemini embeddings. Write scope: convex/search.ts (new), convex/specs.ts (publish hook only — additive), convex/catalogue.ts, convex tests, apps/web/src/routes/catalogue/index.tsx, apps/web/src/lib helpers/tests. Do NOT touch schema.ts (specEmbeddings table + by_embedding vectorIndex (768 dims) ALREADY EXIST — read them), keys, billing, gateway.

Read first: AGENTS.md, convex/schema.ts specEmbeddings, convex/specs.ts publish, convex/catalogue.ts listPublic, Convex vector search docs pattern (ctx.vectorSearch in actions), GEMINI_API_KEY is set in convex env (Gemini text-embedding-004, 768 dims, endpoint https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=...).

BUILD:

1. convex/search.ts: internal action embedProject {projectId} — build text (project name + description + tags + endpoint paths/summaries from latest published spec via @zevium/shared parseSpec), call Gemini embed (injectable fetch for tests), upsert specEmbeddings row (one per project). Public action searchCatalogue {query: string, limit?<=20} — embed query, ctx.vectorSearch on by_embedding, then fetch matching PUBLIC+PUBLISHED projects only (filter post-search; never leak private), return same card shape as listPublic items + score. Graceful: Gemini failure → {items: [], degraded: true}.
2. specs.ts publish (and admin/project visibility → public if trivial): after successful publish, ctx.scheduler.runAfter(0, internal.search.embedProject, {projectId}). Additive only.
3. Catalogue UI: search box becomes hybrid — as-you-type substring filter stays instant; a "Search semantically" submit (Enter or button) calls searchCatalogue action, shows ranked results with subtle relevance indicator; clear returns to browse. Degraded → fall back to substring silently. isPending states, skeletons.
4. Backfill: one internal action embedAllPublished (iterate published+public, schedule embedProject each) — run it once via `npx convex run` in VERIFY and report output.
   TESTS: convex-test with injected embeddings (no live Gemini in tests): embed text construction, private/draft exclusion in results, degraded path. Web helper tests if any.
   VERIFY: pnpm typecheck && pnpm test:convex green; npx convex dev --once clean; backfill run output.
   Output: CHANGED list, VERIFY results, DONE or BLOCKED.
